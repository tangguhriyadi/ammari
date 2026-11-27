import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsFolder, recreateScratchDatabase, scratchUrl } from "@ammari/db/test-scratch";
import {
  STALE_POSTING_RUN_ERROR,
  STALE_POSTING_RUN_MINUTES,
  runPosting,
  runPostingExclusive,
  type Database,
  type PostingSource,
} from "../src/runner";

// The run-level posting lock (docs/plans/accounting.md §8.1, Session 12): the cron route and
// "Posting sekarang" never run at the same time, a second caller is told at once (never waits), the
// lock is released after a failed run, runs left `running` by a dead process are closed, and two
// runs that bypass the run lock still never post one key twice (the per-key lock, the backstop).
//
// Real commits on a scratch database of its own (the runs use separate pool connections, which a
// rolled-back test transaction cannot show). The sources are test sources emitting one fixed
// journal, so nothing depends on the other suites' rows.

const SCRATCH_DATABASE = "ammari_scratch_posting_lock";
let client: postgres.Sql;
let db: Database;

const KEY = { sourceType: "lock_test", sourceId: "one", sourceEvent: "paid" };

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A source emitting one balanced journal for KEY; `hold` (if given) keeps the run inside the
 * source until released, `entered` tells the test the run got there. */
function fixedSource(options: { hold?: Promise<void>; entered?: () => void; fail?: boolean } = {}): PostingSource {
  return {
    name: "lock_test",
    ruleVersion: 1,
    async events() {
      options.entered?.();
      if (options.hold) await options.hold;
      if (options.fail) throw new Error("source failed");
      return [
        {
          key: KEY,
          sourceDate: "2027-01-15",
          outcome: {
            kind: "journal",
            description: "Uji kunci posting",
            lines: [
              { accountCode: "1-1201", debit: 10_000, credit: 0 },
              { accountCode: "3-1001", debit: 0, credit: 10_000 },
            ],
          },
        },
      ];
    },
  };
}

async function activeJournalCount(): Promise<number> {
  const [row] = (await client`
    select count(*)::int as count from journal_entries
    where source_type = ${KEY.sourceType} and source_id = ${KEY.sourceId} and source_event = ${KEY.sourceEvent}
      and reversed_by_entry_id is null and kind <> 'reversal'`) as unknown as [{ count: number }];
  return row.count;
}

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 6, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder });
  db = drizzle(client) as unknown as Database;
}, 60_000);

afterAll(async () => {
  await client?.end();
  await dropScratchDatabase(SCRATCH_DATABASE);
});

beforeEach(async () => {
  // Every test starts with no run marked running (the stale-run test leaves none either).
  await client`update posting_runs set status = 'failed', finished_at = greatest(now(), started_at), error = 'test reset' where status = 'running'`;
});

describe("run-level posting lock", () => {
  test("a second run while one is running is skipped at once, then posts nothing twice", async () => {
    const hold = barrier();
    const entered = barrier();
    const first = runPostingExclusive(db, { trigger: "cron", sources: [fixedSource({ hold: hold.promise, entered: entered.release })] });
    await entered.promise;

    const startedAt = Date.now();
    const second = await runPostingExclusive(db, { trigger: "cron", sources: [fixedSource()] });
    expect(second).toEqual({ ran: false });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    hold.release();
    const done = await first;
    expect(done.ran).toBe(true);
    if (done.ran) expect(done.result.insertedCount).toBe(1);

    const again = await runPostingExclusive(db, { trigger: "cron", sources: [fixedSource()] });
    expect(again.ran).toBe(true);
    if (again.ran) {
      expect(again.result.insertedCount).toBe(0);
      expect(again.result.unchangedCount).toBe(1);
    }
    expect(await activeJournalCount()).toBe(1);
  });

  test("the lock is released when a run fails, and the failed run is recorded", async () => {
    await expect(runPostingExclusive(db, { trigger: "cron", sources: [fixedSource({ fail: true })] })).rejects.toThrow(/source failed/);
    const [last] = await client`select status, error from posting_runs order by started_at desc limit 1`;
    expect(last).toMatchObject({ status: "failed", error: "source failed" });
    const next = await runPostingExclusive(db, { trigger: "cron", sources: [fixedSource()] });
    expect(next.ran).toBe(true);
  });

  test("runs left running by a stopped process are closed by the next run; a recent one is left alone", async () => {
    const [stale] = await client`
      insert into posting_runs (trigger, started_at) values ('cron', now() - make_interval(mins => ${STALE_POSTING_RUN_MINUTES + 5})) returning id`;
    const [recent] = await client`insert into posting_runs (trigger, started_at) values ('cron', now() - interval '1 minute') returning id`;

    const run = await runPostingExclusive(db, { trigger: "cron", sources: [fixedSource()] });
    expect(run.ran).toBe(true);
    if (run.ran) expect(run.staleRunsClosed).toBe(1);

    const [staleAfter] = await client`select status, error, finished_at from posting_runs where id = ${stale!.id}`;
    expect(staleAfter).toMatchObject({ status: "failed", error: STALE_POSTING_RUN_ERROR });
    expect(staleAfter!.finished_at).not.toBeNull();
    const [recentAfter] = await client`select status from posting_runs where id = ${recent!.id}`;
    expect(recentAfter!.status).toBe("running");
  });

  test("a run closed as stale while it was still working records its real outcome at the end", async () => {
    const hold = barrier();
    const entered = barrier();
    const running = runPosting(db, { trigger: "cron", sources: [fixedSource({ hold: hold.promise, entered: entered.release })] });
    await entered.promise;
    // What a later run does when this one's lock connection dropped: closes it as stale.
    await client`
      update posting_runs set status = 'failed', finished_at = greatest(now(), started_at), error = ${STALE_POSTING_RUN_ERROR}
      where status = 'running'`;
    hold.release();
    const result = await running;
    const [row] = await client`select status, error from posting_runs where id = ${result.runId}`;
    expect(row).toMatchObject({ status: "succeeded", error: null });
  });

  test("two runs that bypass the run lock still post one key once (per-key lock)", async () => {
    const otherKey = { ...KEY, sourceId: "two" };
    const source = (hold: Promise<void>): PostingSource => {
      const base = fixedSource({ hold });
      return { ...base, async events(d, c) { return (await base.events(d, c)).map((event) => ({ ...event, key: otherKey })); } };
    };
    const hold = barrier();
    const a = runPosting(db, { trigger: "cron", sources: [source(hold.promise)] });
    const b = runPosting(db, { trigger: "cron", sources: [source(hold.promise)] });
    hold.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.insertedCount + rb.insertedCount).toBe(1);
    expect(ra.unchangedCount + rb.unchangedCount).toBe(1);
    const [row] = (await client`
      select count(*)::int as count from journal_entries
      where source_type = ${otherKey.sourceType} and source_id = ${otherKey.sourceId} and reversed_by_entry_id is null and kind <> 'reversal'`) as unknown as [{ count: number }];
    expect(row.count).toBe(1);
  });
});

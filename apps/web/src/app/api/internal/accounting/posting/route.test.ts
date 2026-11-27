import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withRollback, type TestTx } from "@ammari/db/test-utils";
import { withExclusiveRun } from "@ammari/commerce/maintenance";

// docs/plans/accounting.md §8 Session 12: the accounting posting cron route. The auth gate is the
// shared cron-auth (same checks as the sweep); the run lock and the runner have their own tests
// against a real database (packages/accounting/test/posting-run-lock.test.ts). Here: the gate, both
// locks answering "skipped", the counts, and failures answering 500 so the cron log flags them.

let currentDb: TestTx | null = null;
vi.mock("@/lib/db", () => ({
  get defaultDb() {
    if (!currentDb) throw new Error("no test transaction");
    return currentDb;
  },
}));

const { runPostingExclusiveMock } = vi.hoisted(() => ({ runPostingExclusiveMock: vi.fn() }));
vi.mock("@ammari/accounting/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ammari/accounting/runner")>();
  runPostingExclusiveMock.mockImplementation(actual.runPostingExclusive);
  return { ...actual, runPostingExclusive: runPostingExclusiveMock };
});

const route = await import("./route");
const actualRunner = await vi.importActual<typeof import("@ammari/accounting/runner")>("@ammari/accounting/runner");

const SECRET = randomBytes(24).toString("hex");
const RESULT = { runId: "run-1", insertedCount: 4, reversedCount: 1, unchangedCount: 20, issueCount: 2, failedCount: 0 };

beforeEach(() => {
  process.env.INTERNAL_CRON_SECRET = SECRET;
  runPostingExclusiveMock.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.INTERNAL_CRON_SECRET;
  currentDb = null;
  vi.restoreAllMocks();
  runPostingExclusiveMock.mockImplementation(actualRunner.runPostingExclusive);
});

async function inRollback(fn: (tx: TestTx) => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    currentDb = tx;
    await fn(tx);
  });
}

function call(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return route.POST(new Request("http://web:3000/api/internal/accounting/posting", { method: "POST", headers }));
}

describe("POST /api/internal/accounting/posting", () => {
  test("refused without the secret (503), with a wrong bearer (401), through a proxy (404); never runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    delete process.env.INTERNAL_CRON_SECRET;
    expect((await call()).status).toBe(503);
    process.env.INTERNAL_CRON_SECRET = SECRET;
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: `Bearer ${SECRET}`, "x-ammari-proxy": "caddy" })).status).toBe(404);
    expect((await call({ authorization: `Bearer ${SECRET}`, "cf-connecting-ip": "203.0.113.1" })).status).toBe(404);
    expect(runPostingExclusiveMock).not.toHaveBeenCalled();
  });

  test("a cron run posts as trigger cron and answers the counts", async () => {
    await inRollback(async () => {
      runPostingExclusiveMock.mockResolvedValueOnce({ ran: true, result: RESULT, staleRunsClosed: 1 });
      const response = await call();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ runId: "run-1", inserted: 4, reversed: 1, unchanged: 20, issues: 2, failed: 0, staleRunsClosed: 1 });
      expect(runPostingExclusiveMock).toHaveBeenCalledWith(expect.anything(), { trigger: "cron" });
    });
  });

  test("keys that failed to post answer 500 with the counts (the next run retries)", async () => {
    await inRollback(async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      runPostingExclusiveMock.mockResolvedValueOnce({ ran: true, result: { ...RESULT, failedCount: 2 }, staleRunsClosed: 0 });
      const response = await call();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ failed: 2 });
    });
  });

  test("a run that throws answers 500 without the error text", async () => {
    await inRollback(async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      runPostingExclusiveMock.mockRejectedValueOnce(new Error('relation "secret_table" does not exist'));
      const response = await call();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "posting failed" });
    });
  });

  test("skipped (200) while another cron job holds the shared cron lock", async () => {
    await inRollback(async () => {
      let release: () => void = () => undefined;
      const blocker = new Promise<void>((resolve) => (release = resolve));
      const other = withExclusiveRun(testDb, "paymentSweep", () => blocker);
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const response = await call();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ skipped: "running" });
        expect(runPostingExclusiveMock).not.toHaveBeenCalled();
      } finally {
        release();
        await other;
      }
    });
  });

  test("skipped (200) while a posting run (e.g. Posting sekarang) holds the posting run lock", async () => {
    await inRollback(async () => {
      let release: () => void = () => undefined;
      const blocker = new Promise<void>((resolve) => (release = resolve));
      // The admin button's run, on its own committed connection, holding the real run lock.
      const other = testDb.transaction(async (lockTx) => {
        await lockTx.execute(sql`select pg_advisory_xact_lock(${actualRunner.POSTING_RUN_LOCK_SQL})`);
        await blocker;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const response = await call();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ skipped: "posting_in_progress" });
        expect(runPostingExclusiveMock).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await other;
      }
    });
  });
});

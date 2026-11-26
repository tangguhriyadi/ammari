import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { journalEntries, postingIssues } from "@ammari/db/schema";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { runPosting, type Database, type PostingSource } from "../src/runner";
import type { PostingEvent, PostingKey, PostingOutcome } from "../src/rules/types";

// The two runner extensions Session 9 needs (docs/plans/accounting.md §2), against the real 0049
// triggers: a real event held behind a blocked original follows it across the cut-over (a return on a
// December sale, a cancel on a December payment), unlike a void; and an event whose source date
// drifts (a gateway refund dated by payments.updated_at) keeps its journal while its lines are the
// same. Synthetic sources, so only the runner is under test. Every test rolls back.

async function run(tx: TestTx, events: PostingEvent[]) {
  const source: PostingSource = { name: "session9_test", ruleVersion: 1, events: async () => events };
  const result = await runPosting(tx as Database, { trigger: "cron", sources: [source] });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

const journal = (amount: number): PostingOutcome => ({
  kind: "journal",
  description: "Uji Session 9",
  lines: [
    { accountCode: "1-1101", debit: amount, credit: 0 },
    { accountCode: "2-1201", debit: 0, credit: amount },
  ],
});

const key = (event: string, id: string): PostingKey => ({ sourceType: "session9_test", sourceId: id, sourceEvent: event });

async function active(tx: TestTx, k: PostingKey) {
  return tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, k.sourceType), eq(journalEntries.sourceId, k.sourceId), eq(journalEntries.sourceEvent, k.sourceEvent), isNull(journalEntries.reversedByEntryId), eq(journalEntries.kind, "system")));
}

describe("runner: held events and drifting dates (Session 9)", () => {
  test("a held event follows its December original into 2027; a void with the same dates does not", async () => {
    await withRollback(async (tx) => {
      const id = randomUUID();
      const original = key("original", id);
      const held = key("held", id);
      const voidKey = key("void", id);
      await run(tx, [
        { key: original, sourceDate: "2026-12-10", outcome: journal(1_000) },
        { key: held, sourceDate: "2027-01-05", outcome: journal(400), requiresActiveJournalFor: original, requiresActiveJournalAcrossBooks: true },
        { key: voidKey, sourceDate: "2027-01-05", outcome: journal(1_000), requiresActiveJournalFor: original },
      ]);
      expect(await active(tx, held)).toHaveLength(1);
      expect(await active(tx, voidKey)).toHaveLength(0);
    });
  });

  test("held while the original is an issue (no journal, no second issue), then posted in the same run as the original", async () => {
    await withRollback(async (tx) => {
      const id = randomUUID();
      const original = key("original", id);
      const held = key("held", id);
      const heldEvent: PostingEvent = { key: held, sourceDate: "2026-12-12", outcome: journal(400), requiresActiveJournalFor: original, requiresActiveJournalAcrossBooks: true };
      await run(tx, [{ key: original, sourceDate: "2026-12-10", outcome: { kind: "issue", issueCode: "session9_blocked", details: {} } }, heldEvent]);
      expect(await active(tx, held)).toHaveLength(0);
      const issues = await tx.select().from(postingIssues).where(and(eq(postingIssues.sourceId, id), isNull(postingIssues.resolvedAt)));
      expect(issues.map((issue) => issue.sourceEvent)).toEqual(["original"]);

      await run(tx, [{ key: original, sourceDate: "2026-12-10", outcome: journal(1_000) }, heldEvent]);
      expect(await active(tx, original)).toHaveLength(1);
      expect(await active(tx, held)).toHaveLength(1);
    });
  });

  test("dateFollowsActive: a later source date with the same lines changes nothing; a new amount re-posts", async () => {
    await withRollback(async (tx) => {
      const k = key("gateway_refunded", randomUUID());
      await run(tx, [{ key: k, sourceDate: "2026-12-06", outcome: journal(100_000), dateFollowsActive: true }]);
      const bumped = await run(tx, [{ key: k, sourceDate: "2026-12-20", outcome: journal(100_000), dateFollowsActive: true }]);
      expect(bumped.insertedCount).toBe(0);
      expect(bumped.reversedCount).toBe(0);
      expect((await active(tx, k))[0]?.sourceDate).toBe("2026-12-06");

      const changed = await run(tx, [{ key: k, sourceDate: "2026-12-20", outcome: journal(150_000), dateFollowsActive: true }]);
      expect(changed.insertedCount).toBe(1);
      expect(changed.reversedCount).toBe(1);
      expect((await active(tx, k))[0]?.sourceDate).toBe("2026-12-20");

      // Without the flag, the same date drift would re-post.
      const plain = key("plain", randomUUID());
      await run(tx, [{ key: plain, sourceDate: "2026-12-06", outcome: journal(100_000) }]);
      expect((await run(tx, [{ key: plain, sourceDate: "2026-12-20", outcome: journal(100_000) }])).reversedCount).toBe(1);
    });
  });
});

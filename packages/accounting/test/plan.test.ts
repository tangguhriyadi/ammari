import { describe, expect, test } from "vitest";
import { monthEndOf, nextMonthStart, postingDateFor, jakartaDateOf } from "../src/dates";
import { decideAction, journalContentHash, planEvent } from "../src/plan";
import type { PostingEvent } from "../src/rules/types";
import { defaultContext } from "./context";

// The runner's pure half (docs/plans/accounting.md §2, §4.8): validation before writing, the
// content hash that tells "unchanged" from "changed", the per-key decision, and period dating.

const key = { sourceType: "business_expense", sourceId: "e1", sourceEvent: "paid" };

function journalEvent(lines: { accountCode: string; debit: number; credit: number; cashAccountCode?: string }[], sourceType = "business_expense"): PostingEvent {
  return { key: { ...key, sourceType }, sourceDate: "2026-12-05", outcome: { kind: "journal", description: "Biaya", lines } };
}

const balanced = [
  { accountCode: "6-2101", debit: 100, credit: 0 },
  { accountCode: "1-1201", debit: 0, credit: 100 },
];

describe("planEvent", () => {
  test("a valid journal is planned with its content hash", () => {
    const planned = planEvent(journalEvent(balanced), 1, defaultContext());
    expect(planned).toMatchObject({ kind: "journal", ruleVersion: 1, contentHash: journalContentHash(1, "2026-12-05", balanced) });
  });

  test("an unbalanced journal becomes an issue, never a plug", () => {
    const planned = planEvent(journalEvent([balanced[0]!, { accountCode: "1-1201", debit: 0, credit: 90 }]), 1, defaultContext());
    expect(planned).toMatchObject({ kind: "issue", issueCode: "invalid_journal" });
  });

  test("a header, inactive or unknown account becomes an issue", () => {
    const context = defaultContext();
    const inactive = new Map(context.accounts);
    inactive.set("6-2101", { type: "expense", isActive: false, isHeader: false });
    expect(planEvent(journalEvent([{ ...balanced[0]!, accountCode: "6-2000" }, balanced[1]!]), 1, context)).toMatchObject({
      kind: "issue",
      issueCode: "account_not_postable",
      details: { accountCodes: ["6-2000"] },
    });
    expect(planEvent(journalEvent(balanced), 1, { ...context, accounts: inactive })).toMatchObject({ issueCode: "account_not_postable" });
    expect(planEvent(journalEvent([{ ...balanced[0]!, accountCode: "6-9999" }, balanced[1]!]), 1, context)).toMatchObject({ issueCode: "account_not_postable" });
    expect(planEvent(journalEvent([balanced[0]!, { ...balanced[1]!, cashAccountCode: "1-1200" }]), 1, context)).toMatchObject({
      issueCode: "account_not_postable",
      details: { accountCodes: ["1-1200"] },
    });
  });

  test("a supplier payment journal on an expense account is refused by the D-14 guard", () => {
    const planned = planEvent(journalEvent(balanced, "supplier_payment"), 1, defaultContext());
    expect(planned).toMatchObject({ kind: "issue", issueCode: "purchase_guard_violation", details: { accountCodes: ["6-2101"] } });
  });

  test("issues and none pass through", () => {
    expect(planEvent({ key, sourceDate: "2026-12-05", outcome: { kind: "none" } }, 1, defaultContext())).toEqual({ kind: "none", key, sourceDate: "2026-12-05" });
    expect(planEvent({ key, sourceDate: "2026-12-05", outcome: { kind: "issue", issueCode: "x", details: { a: 1 } } }, 1, defaultContext())).toMatchObject({
      kind: "issue",
      issueCode: "x",
    });
  });
});

describe("journalContentHash", () => {
  test("changes with the rule version, source date, accounts, amounts and dimensions", () => {
    const base = journalContentHash(1, "2026-12-05", balanced);
    expect(journalContentHash(1, "2026-12-05", balanced)).toBe(base);
    expect(journalContentHash(2, "2026-12-05", balanced)).not.toBe(base);
    expect(journalContentHash(1, "2026-12-06", balanced)).not.toBe(base);
    expect(journalContentHash(1, "2026-12-05", [{ ...balanced[0]!, accountCode: "6-2901" }, balanced[1]!])).not.toBe(base);
    expect(journalContentHash(1, "2026-12-05", [{ ...balanced[0]!, debit: 101 }, { ...balanced[1]!, credit: 101 }])).not.toBe(base);
    expect(journalContentHash(1, "2026-12-05", [{ ...balanced[0]!, supplierId: "s" }, balanced[1]!])).not.toBe(base);
  });

  test("ignores memos (a renamed category or supplier never re-posts history)", () => {
    expect(journalContentHash(1, "2026-12-05", [{ ...balanced[0]!, memo: "Gaji Desember" }, balanced[1]!])).toBe(journalContentHash(1, "2026-12-05", balanced));
  });
});

describe("decideAction", () => {
  const planned = planEvent(journalEvent(balanced), 1, defaultContext());
  if (planned.kind !== "journal") throw new Error("expected a journal plan");

  test("insert / unchanged / reverse + insert", () => {
    expect(decideAction(planned, undefined)).toBe("insert");
    expect(decideAction(planned, planned.contentHash)).toBe("unchanged");
    expect(decideAction(planned, "0".repeat(64))).toBe("reverse_and_insert");
  });

  test("none reverses an active journal, else skips", () => {
    const none = { kind: "none" as const, key, sourceDate: "2026-12-05" };
    expect(decideAction(none, planned.contentHash)).toBe("reverse");
    expect(decideAction(none, undefined)).toBe("skip");
  });

  test("an issue never un-posts an active journal", () => {
    expect(decideAction({ kind: "issue", key, sourceDate: "2026-12-05", issueCode: "x", details: {} }, planned.contentHash)).toBe("issue");
  });
});

describe("period dates", () => {
  test("jakartaDateOf crosses midnight at 17:00 UTC", () => {
    expect(jakartaDateOf(new Date("2026-12-31T16:59:59Z"))).toBe("2026-12-31");
    expect(jakartaDateOf(new Date("2026-12-31T17:00:00Z"))).toBe("2027-01-01");
  });

  test("month arithmetic", () => {
    expect(nextMonthStart("2026-12-15")).toBe("2027-01-01");
    expect(nextMonthStart("2027-01-01")).toBe("2027-02-01");
    expect(monthEndOf("2027-02-10")).toBe("2027-02-28");
    expect(monthEndOf("2026-12-01")).toBe("2026-12-31");
  });

  test("an entry in an open month keeps its date; in a closed one it moves to the first open month (D-23)", () => {
    expect(postingDateFor("2027-01-17", new Set())).toBe("2027-01-17");
    expect(postingDateFor("2027-01-17", new Set(["2027-01-01"]))).toBe("2027-02-01");
    expect(postingDateFor("2027-01-17", new Set(["2027-01-01", "2027-02-01"]))).toBe("2027-03-01");
    expect(postingDateFor("2027-01-17", new Set(["2027-02-01"]))).toBe("2027-01-17");
  });
});

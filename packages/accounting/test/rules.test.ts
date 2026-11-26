import { describe, expect, test } from "vitest";
import { isBalancedJournal } from "../src/journal";
import { expenseRule, type ExpenseSnapshot } from "../src/rules/expenses";
import { supplierPaymentRule, type SupplierPaymentSnapshot } from "../src/rules/supplier-payments";
import type { PostingEvent, PostingOutcome } from "../src/rules/types";
import { defaultContext } from "./context";

// Posting rules E1-E2 (business expenses), P3-P4 and R4 (supplier payments, without chain):
// docs/plans/accounting.md §4.4, §4.5, §4.7, decisions D-11, D-14, D-17, D-18, D-25.

function expense(overrides: Partial<ExpenseSnapshot> = {}): ExpenseSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    expenseNo: "BYA-202612-001",
    expenseDate: "2026-12-05",
    categoryCode: "salary",
    categoryName: "Gaji",
    itemId: null,
    itemName: null,
    amount: 2_500_000,
    method: "transfer",
    channelId: null,
    voidedAt: null,
    ...overrides,
  };
}

function payment(overrides: Partial<SupplierPaymentSnapshot> = {}): SupplierPaymentSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    paymentNo: "BYR-202612-001",
    targetType: "purchase",
    documentNo: "PO-202612-001",
    supplierId: "33333333-3333-4333-8333-333333333333",
    supplierName: "Toko Kain",
    paidAt: "2026-12-07",
    amount: 1_000_000,
    method: "transfer",
    voidedAt: null,
    ...overrides,
  };
}

type Journal = Extract<PostingOutcome, { kind: "journal" }>;

function journalOf(event: PostingEvent | undefined): Journal {
  if (event?.outcome.kind !== "journal") throw new Error(`expected a journal, got ${JSON.stringify(event?.outcome)}`);
  return event.outcome;
}

/** "Dr 6-2101 2500000" / "Cr 1-1201 2500000", in line order. */
function sides(journal: Journal): string[] {
  return journal.lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`));
}

describe("E1 expense recorded", () => {
  test("debits the mapped category account and credits the bank for a transfer, dated expense_date", () => {
    const [paid, ...rest] = expenseRule.events(expense(), defaultContext());
    expect(rest).toEqual([]);
    expect(paid?.key).toEqual({ sourceType: "business_expense", sourceId: expense().id, sourceEvent: "paid" });
    expect(paid?.sourceDate).toBe("2026-12-05");
    const journal = journalOf(paid);
    expect(sides(journal)).toEqual(["Dr 6-2101 2500000", "Cr 1-1201 2500000"]);
    expect(isBalancedJournal(journal.lines)).toBe(true);
    expect(journal.description).toBe("Biaya BYA-202612-001: Gaji");
    expect(journal.lines.every((line) => line.cashAccountCode === "1-1201")).toBe(true);
  });

  test.each([
    ["cash", "1-1101"],
    ["transfer", "1-1201"],
    // D-18: "Kartu" is a debit card and reduces Bank utama.
    ["card", "1-1201"],
  ] as const)("method %s credits %s (D-17, D-18)", (method, account) => {
    const journal = journalOf(expenseRule.events(expense({ method }), defaultContext())[0]);
    expect(sides(journal)).toEqual(["Dr 6-2101 2500000", `Cr ${account} 2500000`]);
  });

  test.each([
    ["shopee", "1-1302"],
    ["tiktok", "1-1303"],
    // M4 / D-11: a marketplace-balance expense without a marketplace goes to the clearing account.
    [null, "1-1305"],
    ["web", "1-1305"],
  ] as const)("platform balance with channel %s credits %s (M4, D-11)", (channelId, account) => {
    const journal = journalOf(expenseRule.events(expense({ method: "platform_balance", categoryCode: "ads_shopee", channelId }), defaultContext())[0]);
    expect(sides(journal)).toEqual(["Dr 6-1101 2500000", `Cr ${account} 2500000`]);
    expect(journal.lines.every((line) => line.channelId === channelId)).toBe(true);
  });

  test("an item mapping overrides the category mapping (D-25)", () => {
    const itemId = "44444444-4444-4444-8444-444444444444";
    const context = defaultContext({ mappings: { [`expense.item.${itemId}`]: "6-2501" } });
    const journal = journalOf(expenseRule.events(expense({ categoryCode: "other", categoryName: "Lainnya", itemId, itemName: "Biteship Grow" }), context)[0]);
    expect(sides(journal)).toEqual(["Dr 6-2501 2500000", "Cr 1-1201 2500000"]);
    expect(journal.description).toBe("Biaya BYA-202612-001: Lainnya, Biteship Grow");
  });

  test("an item without its own mapping falls back to the category", () => {
    const journal = journalOf(expenseRule.events(expense({ itemId: "55555555-5555-4555-8555-555555555555", itemName: "Gaji penjahit" }), defaultContext())[0]);
    expect(sides(journal)).toEqual(["Dr 6-2101 2500000", "Cr 1-1201 2500000"]);
  });

  test("a category mapped to a liability posts there, so paying an accrual is not a second expense (D-25)", () => {
    const context = defaultContext({ mappings: { "expense.category.tax_payment": "2-1401" } });
    const journal = journalOf(expenseRule.events(expense({ categoryCode: "tax_payment", categoryName: "Setor pajak" }), context)[0]);
    expect(sides(journal)).toEqual(["Dr 2-1401 2500000", "Cr 1-1201 2500000"]);
  });

  test("an unmapped category is a posting issue, never a guess (D-25)", () => {
    const [paid] = expenseRule.events(expense({ categoryCode: "langganan", categoryName: "Langganan" }), defaultContext());
    expect(paid?.outcome).toEqual({
      kind: "issue",
      issueCode: "unmapped_expense_category",
      details: { mappingKey: "expense.category.langganan", category: "langganan", categoryName: "Langganan" },
    });
  });

  test("an unmapped payment method is a posting issue", () => {
    const [paid] = expenseRule.events(expense({ method: "cash" }), defaultContext({ mappings: { "cash.method.cash": null } }));
    expect(paid?.outcome).toMatchObject({ kind: "issue", issueCode: "unmapped_payment_method", details: { method: "cash" } });
  });

  test("an expense mapped to an inventory account (1-15xx) is refused: materials reach inventory only through receipts (D-14)", () => {
    const [paid] = expenseRule.events(expense({ categoryCode: "material_shipping" }), defaultContext({ mappings: { "expense.category.material_shipping": "1-1501" } }));
    expect(paid?.outcome).toMatchObject({ kind: "issue", issueCode: "expense_mapped_to_inventory", details: { accountCode: "1-1501" } });
  });

  test("the Biteship balance (1-1603) is an allowed target: a top-up recorded as an expense is not expensed twice", () => {
    const journal = journalOf(expenseRule.events(expense(), defaultContext({ mappings: { "expense.category.salary": "1-1603" } }))[0]);
    expect(sides(journal)).toEqual(["Dr 1-1603 2500000", "Cr 1-1201 2500000"]);
  });
});

describe("E2 expense voided", () => {
  test("posts the exact negation of E1, dated voided_at in Jakarta", () => {
    // 17:30 UTC on 9 Dec = 00:30 WIB on 10 Dec.
    const events = expenseRule.events(expense({ voidedAt: new Date("2026-12-09T17:30:00Z") }), defaultContext());
    expect(events.map((event) => event.key.sourceEvent)).toEqual(["paid", "void"]);
    const voided = events[1];
    expect(voided?.sourceDate).toBe("2026-12-10");
    expect(voided?.requiresActiveJournalFor).toEqual({ sourceType: "business_expense", sourceId: expense().id, sourceEvent: "paid" });
    const journal = journalOf(voided);
    expect(sides(journal)).toEqual(["Cr 6-2101 2500000", "Dr 1-1201 2500000"]);
    expect(journal.description).toBe("Pembatalan biaya BYA-202612-001");
    expect(isBalancedJournal(journal.lines)).toBe(true);
  });

  test("a void of an unmapped expense carries the same issue", () => {
    const events = expenseRule.events(expense({ categoryCode: "langganan", voidedAt: new Date("2026-12-09T03:00:00Z") }), defaultContext());
    expect(events.map((event) => event.outcome.kind)).toEqual(["issue", "issue"]);
  });
});

describe("cut-over (plan §2)", () => {
  test("an expense dated before the posting start is not posted; its void waits on E1's active journal, which never exists (plan §2)", () => {
    const events = expenseRule.events(expense({ expenseDate: "2026-11-30", voidedAt: new Date("2026-12-03T03:00:00Z") }), defaultContext());
    expect(events.map((event) => [event.key.sourceEvent, event.sourceDate, event.outcome.kind])).toEqual([
      ["paid", "2026-11-30", "none"],
      ["void", "2026-12-03", "journal"],
    ]);
    // The runner posts the void only while this key has an active journal.
    expect(events[1]?.requiresActiveJournalFor).toEqual(events[0]?.key);
  });

  test("the first day of the posting start is posted", () => {
    expect(expenseRule.events(expense({ expenseDate: "2026-12-01" }), defaultContext())[0]?.outcome.kind).toBe("journal");
  });

  test("the paid event never waits on anything", () => {
    expect(expenseRule.events(expense(), defaultContext())[0]?.requiresActiveJournalFor).toBeUndefined();
  });

  test("a supplier payment before the posting start is not posted; its void waits on P3's active journal (P4)", () => {
    const events = supplierPaymentRule.events(payment({ paidAt: "2026-11-28", voidedAt: new Date("2026-12-02T03:00:00Z") }), defaultContext());
    expect(events.map((event) => [event.key.sourceEvent, event.outcome.kind])).toEqual([
      ["paid", "none"],
      ["void", "journal"],
    ]);
    expect(events[1]?.requiresActiveJournalFor).toEqual(events[0]?.key);
  });
});

describe("P3 / R4 supplier payment (without chain)", () => {
  test("a purchase payment clears utang pemasok bahan from the bank (P3)", () => {
    const [paid] = supplierPaymentRule.events(payment(), defaultContext());
    expect(paid?.key).toEqual({ sourceType: "supplier_payment", sourceId: payment().id, sourceEvent: "paid" });
    expect(paid?.sourceDate).toBe("2026-12-07");
    const journal = journalOf(paid);
    expect(sides(journal)).toEqual(["Dr 2-1101 1000000", "Cr 1-1201 1000000"]);
    expect(journal.lines.every((line) => line.supplierId === payment().supplierId)).toBe(true);
    expect(journal.description).toBe("Pembayaran pembelian PO-202612-001 ke Toko Kain (BYR-202612-001)");
  });

  test("cash payments credit Kas tunai (D-17)", () => {
    const journal = journalOf(supplierPaymentRule.events(payment({ method: "cash" }), defaultContext())[0]);
    expect(sides(journal)).toEqual(["Dr 2-1101 1000000", "Cr 1-1101 1000000"]);
  });

  test("a batch payment clears utang jasa produksi (R4)", () => {
    const journal = journalOf(supplierPaymentRule.events(payment({ targetType: "production_batch", documentNo: "BTC-202612-001", supplierName: "Penjahit" }), defaultContext())[0]);
    expect(sides(journal)).toEqual(["Dr 2-1102 1000000", "Cr 1-1201 1000000"]);
    expect(journal.description).toBe("Pembayaran produksi BTC-202612-001 ke Penjahit (BYR-202612-001)");
  });

  test("a batch payment without a payee clears utang tanpa pemasok (R4)", () => {
    const journal = journalOf(
      supplierPaymentRule.events(payment({ targetType: "production_batch", documentNo: "BTC-202612-001", supplierId: null, supplierName: null }), defaultContext())[0],
    );
    expect(sides(journal)).toEqual(["Dr 2-1103 1000000", "Cr 1-1201 1000000"]);
    expect(journal.description).toContain("ke tanpa pemasok");
  });

  test("a void posts the exact negation, dated voided_at in Jakarta (P4)", () => {
    const events = supplierPaymentRule.events(payment({ voidedAt: new Date("2026-12-20T02:00:00Z") }), defaultContext());
    const voided = events[1];
    expect(voided?.key.sourceEvent).toBe("void");
    expect(voided?.sourceDate).toBe("2026-12-20");
    expect(voided?.requiresActiveJournalFor).toEqual({ sourceType: "supplier_payment", sourceId: payment().id, sourceEvent: "paid" });
    expect(sides(journalOf(voided))).toEqual(["Cr 2-1101 1000000", "Dr 1-1201 1000000"]);
  });

  test("supplier payment journals never touch an expense-like account (D-14)", () => {
    const context = defaultContext();
    for (const snapshot of [payment(), payment({ targetType: "production_batch", supplierId: null, supplierName: null }), payment({ voidedAt: new Date() })]) {
      for (const event of supplierPaymentRule.events(snapshot, context)) {
        for (const line of journalOf(event).lines) {
          expect(["asset", "liability"]).toContain(context.accounts.get(line.accountCode)?.type);
        }
      }
    }
  });
});

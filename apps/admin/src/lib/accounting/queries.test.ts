import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { journalEntries, journalLines, suppliers } from "@ammari/db/schema";
import { parseJournalFilters, parseLedgerFilters } from "./filters";
import { getLedger, listJournalEntries } from "./queries";

// Journals are written straight into the tables here (the runner is tested in packages/accounting),
// dated in 2031, a year no other suite posts in, and every ledger read is narrowed to a supplier
// created in the test, so rows other suites leave in ammari_test never match. Each test rolls
// back; the deferred balance check never fires, but every entry below balances anyway.

let entrySeq = 0;

async function entry(
  tx: TestTx,
  input: { date: string; kind?: "system" | "reversal"; reverses?: string; description: string; lines: { account: string; debit?: number; credit?: number; supplierId?: string }[] },
): Promise<{ id: string; entryNo: string }> {
  entrySeq += 1;
  const entryNo = `JU-${input.date.slice(0, 4)}${input.date.slice(5, 7)}-${String(9000 + entrySeq).padStart(4, "0")}`;
  const kind = input.kind ?? "system";
  const [row] = await tx
    .insert(journalEntries)
    .values({
      entryNo,
      entryDate: input.date,
      sourceDate: input.date,
      sourceType: "business_expense",
      sourceId: randomUUID(),
      sourceEvent: "paid",
      ruleVersion: 1,
      kind,
      reversesEntryId: input.reverses ?? null,
      description: input.description,
    })
    .returning({ id: journalEntries.id, entryNo: journalEntries.entryNo });
  await tx.insert(journalLines).values(
    input.lines.map((line, index) => ({
      entryId: row!.id,
      lineNo: index + 1,
      accountCode: line.account,
      debit: line.debit ?? 0,
      credit: line.credit ?? 0,
      supplierId: line.supplierId ?? null,
    })),
  );
  return row!;
}

describe("listJournalEntries", () => {
  test("lists entries in the range newest first, with lines, account names and filters", async () => {
    await withRollback(async (tx) => {
      const first = await entry(tx, { date: "2031-05-02", description: "Biaya gaji", lines: [{ account: "6-2101", debit: 100 }, { account: "1-1201", credit: 100 }] });
      const second = await entry(tx, { date: "2031-05-03", description: "Biaya sewa", lines: [{ account: "6-2201", debit: 50 }, { account: "1-1101", credit: 50 }] });
      await entry(tx, { date: "2031-06-01", description: "Bulan lain", lines: [{ account: "6-2101", debit: 1 }, { account: "1-1201", credit: 1 }] });

      const { rows, pagination } = await listJournalEntries(parseJournalFilters({ from: "2031-05-01", to: "2031-05-31" }, "2031-05-10"), undefined, undefined, tx);

      expect(rows.map((row) => row.entryNo)).toEqual([second.entryNo, first.entryNo]);
      expect(pagination.totalCount).toBe(2);
      expect(rows[1]!.lines).toEqual([
        { lineNo: 1, accountCode: "6-2101", accountName: "Gaji", debit: 100, credit: 0, memo: null },
        { lineNo: 2, accountCode: "1-1201", accountName: "Bank utama", debit: 0, credit: 100, memo: null },
      ]);
      expect(rows[1]!.debitTotal).toBe(100);

      const byAccount = await listJournalEntries(parseJournalFilters({ from: "2031-05-01", to: "2031-05-31", account: "1-1101" }, "2031-05-10"), undefined, undefined, tx);
      expect(byAccount.rows.map((row) => row.entryNo)).toEqual([second.entryNo]);
    });
  });

  test("links a reversal and the entry it reverses both ways", async () => {
    await withRollback(async (tx) => {
      const original = await entry(tx, { date: "2031-05-02", description: "Biaya gaji", lines: [{ account: "6-2101", debit: 100 }, { account: "1-1201", credit: 100 }] });
      const reversal = await entry(tx, {
        date: "2031-05-04",
        kind: "reversal",
        reverses: original.id,
        description: "Pembalik",
        lines: [{ account: "6-2101", credit: 100 }, { account: "1-1201", debit: 100 }],
      });
      await tx.update(journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(journalEntries.id, original.id));

      const { rows } = await listJournalEntries(parseJournalFilters({ from: "2031-05-01", to: "2031-05-31" }, "2031-05-10"), undefined, undefined, tx);

      expect(rows.map((row) => [row.entryNo, row.kind, row.reversesEntryNo, row.reversedByEntryNo])).toEqual([
        [reversal.entryNo, "reversal", original.entryNo, null],
        [original.entryNo, "system", null, reversal.entryNo],
      ]);
    });
  });
});

describe("getLedger", () => {
  test("opening balance, lines with a running balance, and closing balance in the normal direction", async () => {
    await withRollback(async (tx) => {
      const [supplier] = await tx.insert(suppliers).values({ name: `Uji Buku Besar ${randomUUID().slice(0, 8)}` }).returning({ id: suppliers.id });
      const supplierId = supplier!.id;
      // Utang (credit-normal): a receipt-like credit before the range, then payments inside it.
      await entry(tx, { date: "2031-04-20", description: "Utang awal", lines: [{ account: "1-1601", debit: 1000, supplierId }, { account: "2-1101", credit: 1000, supplierId }] });
      await entry(tx, { date: "2031-05-03", description: "Bayar 1", lines: [{ account: "2-1101", debit: 300, supplierId }, { account: "1-1201", credit: 300, supplierId }] });
      await entry(tx, { date: "2031-05-09", description: "Bayar 2", lines: [{ account: "2-1101", debit: 200, supplierId }, { account: "1-1201", credit: 200, supplierId }] });
      await entry(tx, { date: "2031-06-02", description: "Sesudah", lines: [{ account: "2-1101", debit: 1, supplierId }, { account: "1-1201", credit: 1, supplierId }] });

      const ledger = await getLedger(parseLedgerFilters({ account: "2-1101", supplier: supplierId, from: "2031-05-01", to: "2031-05-31" }, "2031-05-10"), undefined, undefined, tx);

      expect(ledger).toMatchObject({ openingBalance: 1000, debitTotal: 500, creditTotal: 0, closingBalance: 500, account: { code: "2-1101", normalBalance: "credit" } });
      expect(ledger!.rows.map((row) => [row.entryDate, row.debit, row.credit, row.balance])).toEqual([
        ["2031-05-03", 300, 0, 700],
        ["2031-05-09", 200, 0, 500],
      ]);

      // Debit-normal (Bank): 0 opening for this supplier, two credits → negative balance.
      const bank = await getLedger(parseLedgerFilters({ account: "1-1201", supplier: supplierId, from: "2031-05-01", to: "2031-05-31" }, "2031-05-10"), undefined, undefined, tx);
      expect(bank).toMatchObject({ openingBalance: 0, creditTotal: 500, closingBalance: -500 });
      expect(bank!.rows.map((row) => row.balance)).toEqual([-300, -500]);
    });
  });

  test("the running balance continues across pages", async () => {
    await withRollback(async (tx) => {
      const [supplier] = await tx.insert(suppliers).values({ name: `Uji Halaman ${randomUUID().slice(0, 8)}` }).returning({ id: suppliers.id });
      for (let day = 1; day <= 12; day += 1) {
        const date = `2031-05-${String(day).padStart(2, "0")}`;
        await entry(tx, { date, description: `Bayar ${day}`, lines: [{ account: "2-1101", debit: 10, supplierId: supplier!.id }, { account: "1-1201", credit: 10, supplierId: supplier!.id }] });
      }
      const filters = parseLedgerFilters({ account: "2-1101", supplier: supplier!.id, from: "2031-05-01", to: "2031-05-31" }, "2031-05-10");

      const page2 = await getLedger(filters, "2", "10", tx);

      expect(page2!.pagination).toMatchObject({ page: 2, totalCount: 12 });
      expect(page2!.rows.map((row) => row.balance)).toEqual([-110, -120]);
    });
  });

  test("no account, a header account or an unknown one gives no ledger", async () => {
    await withRollback(async (tx) => {
      expect(await getLedger(parseLedgerFilters({}, "2031-05-10"), undefined, undefined, tx)).toBeNull();
      expect(await getLedger(parseLedgerFilters({ account: "1-1500" }, "2031-05-10"), undefined, undefined, tx)).toBeNull();
      expect(await getLedger(parseLedgerFilters({ account: "9-9999" }, "2031-05-10"), undefined, undefined, tx)).toBeNull();
    });
  });
});

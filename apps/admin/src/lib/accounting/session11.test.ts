import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkPostingCompleteness, defaultPostingSources, fixedAssetSource, runPosting, type Database as LedgerDatabase } from "@ammari/accounting/runner";
import { auditLog, fiscalPeriods, fixedAssets, journalEntries, journalLines, taxSettings } from "@ammari/db/schema";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { closePostingsSummary } from "./close-postings-text";
import { FIXED_ASSET_MESSAGES } from "./fixed-asset-input";
import { createFixedAsset, disposeFixedAsset, listFixedAssets, updateFixedAsset, updateFixedAssetGroup, voidFixedAsset } from "./fixed-assets";
import { insertStaffJournal } from "./manual-journals";
import { closePeriod, listPeriods, reopenPeriod } from "./periods";
import { getIncomeStatement } from "./statements";

// Session 11 against ammari_test (docs/plans/accounting.md §5.3, §5.6, §5.7; D-19, D-20, D-23): the
// fixed asset register posts acquisition / depreciation / disposal through the runner (idempotent;
// an edit or void is reversed and re-posted, into the first open month when the month is closed);
// closing a month posts the PPh final accrual from tax_settings (never after the rate's end date) and
// December's close posts the year-end closing journal. Every test rolls back.

afterEach(() => {
  vi.useRealTimers();
});

const IN_MARCH = new Date("2027-03-15T05:00:00Z");

async function post(tx: TestTx, now: Date) {
  return runPosting(tx as unknown as LedgerDatabase, { trigger: "cron", sources: [fixedAssetSource({ now })] });
}

const ASSET = {
  name: "Mesin jahit Juki",
  groupCode: "group_1",
  acquisitionDate: "2027-01-20",
  cost: "12.000.000",
  assetAccountCode: "1-2101",
  accumulatedAccountCode: "1-2191",
  fundingAccountCode: "1-1201",
  note: "",
};

async function journalsOf(tx: TestTx, assetId: string) {
  return tx
    .select({ entryNo: journalEntries.entryNo, entryDate: journalEntries.entryDate, sourceEvent: journalEntries.sourceEvent, kind: journalEntries.kind, reversedBy: journalEntries.reversedByEntryId })
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, "fixed_asset"), eq(journalEntries.sourceId, assetId)))
    .orderBy(asc(journalEntries.entryNo));
}

async function activeLines(tx: TestTx, assetId: string) {
  return tx
    .select({ sourceEvent: journalEntries.sourceEvent, accountCode: journalLines.accountCode, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.sourceType, "fixed_asset"), eq(journalEntries.sourceId, assetId), isNull(journalEntries.reversedByEntryId), sql`${journalEntries.kind} <> 'reversal'`))
    .orderBy(asc(journalEntries.sourceEvent), asc(journalLines.lineNo));
}

async function balance(tx: TestTx, code: string, through: string, from = "2027-01-01") {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(l.debit - l.credit), 0)::bigint as net from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_code = ${code} and e.entry_date between ${from} and ${through}
  `)) as unknown as { net: string }[];
  return Number(row?.net ?? 0);
}

describe("fixed asset register and depreciation (D-19)", () => {
  test("register → acquisition + depreciation from the acquisition month; a second run changes nothing", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const asset = await createFixedAsset(ASSET, staff.id, tx, IN_MARCH);
      expect(asset.usefulLifeMonths).toBe(48);
      const first = await post(tx, IN_MARCH);
      expect(first).toMatchObject({ insertedCount: 4, reversedCount: 0, issueCount: 0 });
      const rows = await journalsOf(tx, asset.id);
      expect(rows.map((row) => [row.sourceEvent, row.entryDate, row.kind])).toEqual([
        ["acquired", "2027-01-20", "system"],
        ["dep:2027-01", "2027-01-31", "depreciation"],
        ["dep:2027-02", "2027-02-28", "depreciation"],
        ["dep:2027-03", "2027-03-31", "depreciation"],
      ]);
      expect(await balance(tx, "1-2191", "2027-03-31")).toBe(-750_000);
      expect(await balance(tx, "6-2401", "2027-03-31")).toBe(750_000);
      expect(await balance(tx, "1-2101", "2027-03-31")).toBe(12_000_000);
      const second = await post(tx, IN_MARCH);
      expect(second).toMatchObject({ insertedCount: 0, reversedCount: 0, unchangedCount: 4 });
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "fixed_asset"), eq(auditLog.entityId, asset.id), eq(auditLog.action, "create")));
      expect(audit).toBeDefined();
    });
  });

  test("a raised threshold does not lock an existing asset out of an edit that keeps its cost", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const asset = await createFixedAsset({ ...ASSET, cost: "1.500.000" }, staff.id, tx, IN_MARCH);
      await tx.execute(sql`update fixed_asset_settings set capitalization_threshold = 2000000 where id = 1`);
      await expect(updateFixedAsset(asset.id, { ...ASSET, cost: "1.500.000", fundingAccountCode: "1-1101" }, staff.id, tx, IN_MARCH)).resolves.toBeDefined();
      await expect(updateFixedAsset(asset.id, { ...ASSET, cost: "1.600.000" }, staff.id, tx, IN_MARCH)).rejects.toMatchObject({ field: "cost" });
    });
  });

  test("below the capitalisation threshold is refused (an ordinary expense)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await expect(createFixedAsset({ ...ASSET, cost: "999.999" }, staff.id, tx, IN_MARCH)).rejects.toMatchObject({ field: "cost", message: FIXED_ASSET_MESSAGES.belowThreshold("Rp1.000.000") });
      await expect(createFixedAsset({ ...ASSET, cost: "1.000.000" }, staff.id, tx, IN_MARCH)).resolves.toBeDefined();
    });
  });

  test("an edit after January closed: reversal + repost, the January correction lands in the first open month", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const asset = await createFixedAsset(ASSET, staff.id, tx, IN_MARCH);
      await post(tx, IN_MARCH);
      await tx.insert(fiscalPeriods).values({ month: "2027-01-01", status: "closed", closedAt: new Date(), closedByStaffUserId: staff.id });
      await updateFixedAsset(asset.id, { ...ASSET, cost: "24.000.000" }, staff.id, tx, IN_MARCH);
      const result = await post(tx, IN_MARCH);
      expect(result).toMatchObject({ insertedCount: 4, reversedCount: 4 });
      const rows = await journalsOf(tx, asset.id);
      // January's journals (acquisition, Jan depreciation) were reversed and re-posted on 1 Feb.
      const janEvents = rows.filter((row) => row.sourceEvent === "acquired" || row.sourceEvent === "dep:2027-01").slice(2);
      expect(janEvents.every((row) => row.entryDate === "2027-02-01")).toBe(true);
      expect(await balance(tx, "1-2191", "2027-03-31")).toBe(-1_500_000);
      expect(await balance(tx, "1-2191", "2027-01-31")).toBe(-250_000);
    });
  });

  test("a group edit never re-writes an existing asset's schedule", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const asset = await createFixedAsset(ASSET, staff.id, tx, IN_MARCH);
      await updateFixedAssetGroup("group_1", { label: "Kelompok 1", usefulLifeMonths: "24" }, staff.id, tx);
      await updateFixedAsset(asset.id, { ...ASSET, name: "Mesin jahit Juki DDL" }, staff.id, tx, IN_MARCH);
      const [row] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, asset.id));
      expect(row?.usefulLifeMonths).toBe(48);
      const fresh = await createFixedAsset({ ...ASSET, name: "Obras" }, staff.id, tx, IN_MARCH);
      expect(fresh.usefulLifeMonths).toBe(24);
    });
  });

  test("disposal: depreciation stops before the disposal month, gain/loss on 8-1102; a posted disposal-month depreciation is reversed", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const asset = await createFixedAsset(ASSET, staff.id, tx, IN_MARCH);
      await post(tx, IN_MARCH);
      await disposeFixedAsset(asset.id, { disposedOn: "2027-03-10", proceeds: "11.000.000", cashAccountCode: "1-1101" }, staff.id, tx, IN_MARCH);
      const result = await post(tx, IN_MARCH);
      expect(result).toMatchObject({ insertedCount: 1, reversedCount: 1 });
      const lines = (await activeLines(tx, asset.id)).filter((line) => line.sourceEvent === "disposed");
      expect(lines).toEqual([
        { sourceEvent: "disposed", accountCode: "1-1101", debit: 11_000_000, credit: 0 },
        { sourceEvent: "disposed", accountCode: "1-2191", debit: 500_000, credit: 0 },
        { sourceEvent: "disposed", accountCode: "8-1102", debit: 500_000, credit: 0 },
        { sourceEvent: "disposed", accountCode: "1-2101", debit: 0, credit: 12_000_000 },
      ]);
      expect(await balance(tx, "1-2101", "2027-03-31")).toBe(0);
      expect(await balance(tx, "1-2191", "2027-03-31")).toBe(0);
      const [listed] = (await listFixedAssets(tx, IN_MARCH)).filter((row) => row.id === asset.id);
      expect(listed).toMatchObject({ status: "disposed", bookValue: 0, accumulated: 500_000 });
      await expect(updateFixedAsset(asset.id, ASSET, staff.id, tx, IN_MARCH)).rejects.toMatchObject({ message: FIXED_ASSET_MESSAGES.disposed });
    });
  });

  test("void: every journal reversed by the next run; the row is final and audited", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const asset = await createFixedAsset(ASSET, staff.id, tx, IN_MARCH);
      await post(tx, IN_MARCH);
      await expect(voidFixedAsset(asset.id, "  ", staff.id, tx, IN_MARCH)).rejects.toMatchObject({ field: "reason" });
      await voidFixedAsset(asset.id, "Salah catat, aset milik pribadi", staff.id, tx, IN_MARCH);
      expect(await post(tx, IN_MARCH)).toMatchObject({ insertedCount: 0, reversedCount: 4 });
      expect(await activeLines(tx, asset.id)).toEqual([]);
      expect(await post(tx, IN_MARCH)).toMatchObject({ insertedCount: 0, reversedCount: 0 });
      await expect(tx.transaction((sp) => sp.execute(sql`update fixed_assets set name = 'x' where id = ${asset.id}`))).rejects.toThrow();
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "fixed_asset"), eq(auditLog.entityId, asset.id), eq(auditLog.action, "void")));
      expect(audit).toBeDefined();
    });
  });

  test("an asset already in the books before the cut-over: no acquisition journal, depreciation from the posting start", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const asset = await createFixedAsset({ ...ASSET, acquisitionDate: "2025-07-01", fundingAccountCode: "" }, staff.id, tx, IN_MARCH);
      await post(tx, IN_MARCH);
      const rows = await journalsOf(tx, asset.id);
      expect(rows.map((row) => row.sourceEvent)).toEqual(["dep:2026-12", "dep:2027-01", "dep:2027-02", "dep:2027-03"]);
    });
  });

  test("the default sources include the register, and check 5 has no gap after a run", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await createFixedAsset(ASSET, staff.id, tx, IN_MARCH);
      expect(defaultPostingSources(IN_MARCH).map((source) => source.name)).toContain("fixed_asset");
      await post(tx, IN_MARCH);
      const completeness = await checkPostingCompleteness(tx as unknown as LedgerDatabase, { from: "2027-01-01", to: "2027-03-31" }, { sources: [fixedAssetSource({ now: IN_MARCH })] });
      expect(completeness.gaps).toEqual([]);
      expect(completeness.posted).toBe(4);
    });
  });
});

type Line = [code: string, debit: number, credit: number];

async function journal(tx: TestTx, staffId: string, entryDate: string, lines: Line[]) {
  await insertStaffJournal(tx, {
    kind: "manual",
    entryDate,
    description: "Uji tutup buku",
    lines: lines.map(([accountCode, debit, credit]) => ({ accountCode, debit, credit })),
    file: null,
    actorStaffUserId: staffId,
  });
}

async function pphJournals(tx: TestTx) {
  return tx
    .select({ entryNo: journalEntries.entryNo, entryDate: journalEntries.entryDate, sourceEvent: journalEntries.sourceEvent, kind: journalEntries.kind, reversedBy: journalEntries.reversedByEntryId })
    .from(journalEntries)
    .where(eq(journalEntries.sourceType, "tax"))
    .orderBy(asc(journalEntries.entryNo));
}

/** A tax setting in force from January 2027 without an end date and a small exemption. */
async function validRate(tx: TestTx, exemption = 1_000_000) {
  await tx.insert(taxSettings).values({ effectiveFrom: "2027-01-01", taxpayerType: "individual", taxpayerLabel: "Istri pemilik, orang pribadi", npwpRegisteredYear: 2020, rateBps: 50, annualExemptionAmount: exemption, rateValidUntil: null });
}

describe("PPh final accrual at month close (D-20)", () => {
  test("after the rate's end date: nothing is proposed or posted, and the close warns", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await journal(tx, staff.id, "2027-01-10", [["1-1201", 900_000_000, 0], ["4-1105", 0, 900_000_000]]);
      const january = (await listPeriods(tx, IN_MARCH)).find((row) => row.month === "2027-01-01");
      expect(january?.pphFinal).toMatchObject({ kind: "rate_ended", rateValidUntil: "2026-12-31" });
      expect(january?.warnings).toContain("Tarif PPh final berakhir, periksa pengaturan pajak.");
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      expect(await pphJournals(tx)).toEqual([]);
    });
  });

  test("crossing the exemption: only the part above it, net of vouchers and returns, without ongkir; posted at close, dated the month end", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await validRate(tx);
      // Net sales Jan: 1.500.000 sales − 100.000 voucher − 50.000 return = 1.350.000; ongkir is a liability.
      await journal(tx, staff.id, "2027-01-10", [["1-1302", 1_400_000, 0], ["4-1201", 100_000, 0], ["4-1102", 0, 1_500_000]]);
      await journal(tx, staff.id, "2027-01-11", [["1-1201", 30_000, 0], ["2-1203", 0, 30_000]]);
      await journal(tx, staff.id, "2027-01-12", [["4-1301", 50_000, 0], ["2-1202", 0, 50_000]]);
      const january = (await listPeriods(tx, IN_MARCH)).find((row) => row.month === "2027-01-01");
      expect(january?.pphFinal).toMatchObject({ kind: "accrual", monthBase: 1_350_000, taxable: 350_000, amount: 1_750 });
      expect(closePostingsSummary(january!)[0]).toMatch(/saat tutup: Rp\s?1\.750 /);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      const [entry] = await pphJournals(tx);
      expect(entry).toMatchObject({ entryDate: "2027-01-31", sourceEvent: "2027-01", kind: "system" });
      expect(await balance(tx, "9-1101", "2027-01-31")).toBe(1_750);
      expect(await balance(tx, "2-1401", "2027-01-31")).toBe(-1_750);
      // February: the exemption is used up, so all of February's net sales are taxed.
      await journal(tx, staff.id, "2027-02-03", [["1-1201", 2_000_000, 0], ["4-1105", 0, 2_000_000]]);
      await closePeriod("2027-02-01", null, staff.id, tx, IN_MARCH);
      expect(await balance(tx, "9-1101", "2027-02-28", "2027-02-01")).toBe(10_000);
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "journal_entry"), eq(auditLog.action, "post_pph_final")));
      expect(audit).toBeDefined();
    });
  });

  test("reopen + re-close: unchanged keeps the journal; a change reverses and re-posts in the month", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await validRate(tx);
      await journal(tx, staff.id, "2027-01-10", [["1-1201", 3_000_000, 0], ["4-1105", 0, 3_000_000]]);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      await reopenPeriod("2027-01-01", "Uji hitung ulang", staff.id, tx, IN_MARCH);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      expect((await pphJournals(tx)).length).toBe(1);
      await reopenPeriod("2027-01-01", "Ada penjualan terlambat", staff.id, tx, IN_MARCH);
      await journal(tx, staff.id, "2027-01-28", [["1-1201", 1_000_000, 0], ["4-1105", 0, 1_000_000]]);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      const rows = await pphJournals(tx);
      expect(rows.map((row) => [row.kind, row.entryDate, row.reversedBy !== null])).toEqual([
        ["system", "2027-01-31", true],
        ["reversal", "2027-01-31", false],
        ["system", "2027-01-31", false],
      ]);
      expect(await balance(tx, "9-1101", "2027-01-31")).toBe(15_000);
    });
  });

  test("PPh final is never negative: a month of net returns books nothing and January's accrual stays", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await validRate(tx, 1_000_000);
      await journal(tx, staff.id, "2027-01-10", [["1-1201", 3_000_000, 0], ["4-1105", 0, 3_000_000]]);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      expect(await balance(tx, "9-1101", "2027-01-31")).toBe(10_000);
      // February: only a return of 1.500.000 (net sales negative).
      await journal(tx, staff.id, "2027-02-12", [["4-1301", 1_500_000, 0], ["2-1202", 0, 1_500_000]]);
      const february = (await listPeriods(tx, IN_MARCH)).find((row) => row.month === "2027-02-01");
      expect(february?.pphFinal).toMatchObject({ kind: "accrual", monthBase: -1_500_000, amount: 0 });
      expect(closePostingsSummary(february!)[0]).toContain("tidak dikurangi");
      await closePeriod("2027-02-01", null, staff.id, tx, IN_MARCH);
      const rows = await pphJournals(tx);
      expect(rows.map((row) => [row.sourceEvent, row.reversedBy])).toEqual([["2027-01", null]]);
      expect(await balance(tx, "9-1101", "2027-02-28")).toBe(10_000);
      expect(await balance(tx, "2-1401", "2027-02-28")).toBe(-10_000);
    });
  });

  test("a rate change by a new effective row applies from its month", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await validRate(tx, 0);
      await tx.insert(taxSettings).values({ effectiveFrom: "2027-02-01", taxpayerType: "individual", taxpayerLabel: "Istri pemilik, orang pribadi", rateBps: 100, annualExemptionAmount: 0, rateValidUntil: null });
      await journal(tx, staff.id, "2027-01-10", [["1-1201", 1_000_000, 0], ["4-1105", 0, 1_000_000]]);
      await journal(tx, staff.id, "2027-02-10", [["1-1201", 1_000_000, 0], ["4-1105", 0, 1_000_000]]);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      await closePeriod("2027-02-01", null, staff.id, tx, IN_MARCH);
      expect(await balance(tx, "9-1101", "2027-01-31")).toBe(5_000);
      expect(await balance(tx, "9-1101", "2027-02-28", "2027-02-01")).toBe(10_000);
    });
  });

  test("the close's own PPh journal is not an orphan in check 5", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await validRate(tx, 0);
      await journal(tx, staff.id, "2027-01-10", [["1-1201", 1_000_000, 0], ["4-1105", 0, 1_000_000]]);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      const completeness = await checkPostingCompleteness(tx as unknown as LedgerDatabase, { from: "2027-01-01", to: "2027-01-31" }, { sources: [fixedAssetSource({ now: IN_MARCH })] });
      expect(completeness.orphans).toEqual([]);
    });
  });
});

describe("the close needs an up-to-date ledger (review finding)", () => {
  test("a register change not yet posted refuses the close until Posting sekarang ran", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await createFixedAsset(ASSET, staff.id, tx, IN_MARCH);
      await expect(closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH)).rejects.toMatchObject({ message: expect.stringContaining("Jalankan Posting sekarang") });
      await runPosting(tx as unknown as LedgerDatabase, { trigger: "cron", sources: defaultPostingSources(IN_MARCH) });
      await expect(closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH)).resolves.toBeDefined();
    });
  });
});

describe("year-end closing (§5.7)", () => {
  test("closing December 2027 zeroes every P&L account into Saldo laba and Prive into Modal; Laba rugi unchanged", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await validRate(tx, 0);
      await journal(tx, staff.id, "2027-01-10", [["1-1201", 10_000_000, 0], ["4-1105", 0, 10_000_000]]);
      await journal(tx, staff.id, "2027-03-05", [["6-2101", 2_000_000, 0], ["1-1201", 0, 2_000_000]]);
      await journal(tx, staff.id, "2027-06-05", [["3-1002", 500_000, 0], ["1-1201", 0, 500_000]]);
      const now = new Date("2028-01-15T05:00:00Z");
      const december = (await listPeriods(tx, now)).find((row) => row.month === "2027-12-01");
      expect(december?.closesYear).toBe(true);
      for (let m = 1; m <= 12; m += 1) await closePeriod(`2027-${String(m).padStart(2, "0")}-01`, null, staff.id, tx, now);

      // PPh: 10.000.000 × 0,5% in January.
      expect(await balance(tx, "9-1101", "2027-01-31")).toBe(50_000);
      const [closing] = await tx.select().from(journalEntries).where(and(eq(journalEntries.kind, "closing"), eq(journalEntries.sourceType, "year_close"), eq(journalEntries.sourceId, "2027")));
      expect(closing).toMatchObject({ entryDate: "2027-12-31", sourceEvent: "closing" });
      for (const code of ["4-1105", "6-2101", "9-1101", "3-1002"]) expect(await balance(tx, code, "2027-12-31"), code).toBe(0);
      expect(await balance(tx, "3-2001", "2027-12-31")).toBe(-(10_000_000 - 2_000_000 - 50_000));
      expect(await balance(tx, "3-1001", "2027-12-31")).toBe(500_000);
      const statement = await getIncomeStatement({ from: "2027-01-01", to: "2027-12-31" }, "total", tx);
      expect(statement.statement.figures.netIncome.at(-1)).toBe(7_950_000);
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "journal_entry"), eq(auditLog.action, "post_year_close")));
      expect(audit).toBeDefined();

      // Reopen December, re-close without changes: the closing journal is kept.
      await reopenPeriod("2027-12-01", "Periksa ulang", staff.id, tx, now);
      await closePeriod("2027-12-01", null, staff.id, tx, now);
      expect((await tx.select().from(journalEntries).where(eq(journalEntries.sourceType, "year_close"))).length).toBe(1);
    });
  });
});

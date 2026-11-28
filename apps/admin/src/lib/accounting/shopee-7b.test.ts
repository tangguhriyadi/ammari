import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { runPosting, type Database as LedgerDatabase } from "@ammari/accounting/runner";
import { fiscalPeriods, journalEntries, journalLines, orders, postingIssues, productVariants, stockMovements } from "@ammari/db/schema";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, withTriggerDisabled, type TestTx } from "@ammari/db/test-utils";
import { shopeeRows, xlsxBytes, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { commitImport } from "@/lib/marketplace-import/commit";
import { parseMarketplaceFile, type ParsedImport } from "@/lib/marketplace-import/parse-file";
import { planImport } from "@/lib/marketplace-import/plan";
import { proposeOpeningBalances } from "./opening-balance";

// Session 7b (docs/plans/marketplace-import.md §19.3, accounting.md Session 5 part 1) through the REAL
// import write path: a Shopee order's col 7 "Waktu Pengiriman Diatur" lands in marketplace_shipped_at,
// and the existing sales rule dates M1 by its Jakarta date (no rule change, no version bump). Until the
// date is filled the order is a marketplace_ship_date_missing posting issue. Every test rolls back.

const START = "2020-01-01";

/** Same as session9.test.ts: stock movements are stamped with the database clock, which may be before
 * the books start; the 0056 date floor is lifted inside the rolled-back transaction only. */
async function liftDateFloorBeforeBooksStart(tx: TestTx) {
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  await tx.execute(sql`
    do $$ begin
      if now() < date '2026-12-01' then
        alter table journal_entries drop constraint if exists journal_entries_entry_date_floor_check;
      end if;
    end $$`);
}

async function postAll(tx: TestTx) {
  await liftDateFloorBeforeBooksStart(tx);
  const result = await runPosting(tx as unknown as LedgerDatabase, { trigger: "cron", postingStartDate: START });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

/** A SKU with 10 pcs on the shelf at 87.917 each. */
async function setup(tx: TestTx) {
  const { variant: inserted } = await insertProductVariant(tx);
  // Marketplace SKUs are matched uppercased (plan §2.2); the fixture's is lowercase.
  const [variant] = await tx.update(productVariants).set({ sku: inserted.sku.toUpperCase() }).where(eq(productVariants.sku, inserted.sku)).returning();
  const staff = await insertStaffUser(tx);
  await tx.insert(stockMovements).values({ sku: variant!.sku, qty: 10, valueAmount: 879_170, type: "production", refType: "manual" });
  return { variant: variant!, staff };
}

/** Parsed as uploaded at `now` (the "no more than 1 hour after upload" rule), with the test-only
 * unlock: SHOPEE_MAPPING_VERIFIED stays false. */
function parseAt(fixture: FixtureOrder[], now: Date): ParsedImport {
  const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(shopeeRows(fixture)), assumeMappingVerified: true, now });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function importFile(tx: TestTx, parsed: ParsedImport, staffId: string) {
  const preview = await planImport(parsed, {}, tx as never);
  if (!preview.ok) throw new Error(preview.error.message);
  const outcome = await commitImport({ parsed, fileName: "pesanan.xlsx", options: {}, expectedDigest: preview.value.digest, actorStaffUserId: staffId }, tx as never);
  if (outcome.kind !== "committed") throw new Error(`expected a commit, got ${outcome.kind}: ${JSON.stringify(preview.value.entries)}`);
  return outcome;
}

async function shopeeOrder(tx: TestTx, channelOrderNo: string) {
  const [order] = await tx.select().from(orders).where(and(eq(orders.channelId, "shopee"), eq(orders.channelOrderNo, channelOrderNo)));
  if (!order) throw new Error(`no order ${channelOrderNo}`);
  return order;
}

async function recognised(tx: TestTx, orderId: string) {
  const entries = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, "order"), eq(journalEntries.sourceId, orderId), eq(journalEntries.sourceEvent, "recognised")))
    .orderBy(asc(journalEntries.createdAt), asc(journalEntries.entryNo));
  return Promise.all(
    entries.map(async (entry) => {
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo));
      return { ...entry, sides: lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`)) };
    }),
  );
}

async function openIssueCodes(tx: TestTx, sourceId: string) {
  const rows = await tx.select({ code: postingIssues.issueCode }).from(postingIssues).where(and(eq(postingIssues.sourceId, sourceId), isNull(postingIssues.resolvedAt)));
  return rows.map((row) => row.code);
}

function uniqueNo(tag: string): string {
  return `${tag}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`;
}

describe("M1 for a Shopee order is dated by col 7's Jakarta date (plan §19.3, D-1, D-2)", () => {
  test("shipped without a ship time: a posting issue, never the import time; a later file fills it and M1 posts on 23:30 WIB's own date", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const no = uniqueNo("S7B");
      const lines = [{ sku: variant.sku, qty: 1, lineTotal: 249_000 }];
      const now = new Date("2026-12-28T05:00:00Z");
      await importFile(tx, parseAt([{ orderNo: no, status: "Dikirim", orderedAt: "2026-12-19 10:00", lines }], now), staff.id);
      const order = await shopeeOrder(tx, no);
      expect(order).toMatchObject({ status: "shipped", marketplaceShippedAt: null });

      await postAll(tx);
      expect(await recognised(tx, order.id)).toEqual([]);
      expect(await openIssueCodes(tx, order.id)).toEqual(["marketplace_ship_date_missing"]);

      // 23:30 WIB on 20 Dec is 16:30 UTC the same day: M1 is dated 20 Dec, never 21 Dec.
      await importFile(tx, parseAt([{ orderNo: no, status: "Dikirim", orderedAt: "2026-12-19 10:00", shippedAt: "2026-12-20 23:30", lines }], now), staff.id);
      expect((await shopeeOrder(tx, no)).marketplaceShippedAt).toEqual(new Date("2026-12-20T16:30:00Z"));

      await postAll(tx);
      const m1 = await recognised(tx, order.id);
      expect(m1).toHaveLength(1);
      expect(m1[0]).toMatchObject({ kind: "system", entryDate: "2026-12-20", sourceDate: "2026-12-20" });
      expect(m1[0]!.sides).toEqual(expect.arrayContaining(["Dr 1-1302 249000", "Dr 5-1101 87917", "Cr 1-1505 87917"]));
      expect(await openIssueCodes(tx, order.id)).toEqual([]);
      // Re-running posts nothing new.
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0 });
    });
  });

  test("created already shipped with col 7: M1 posts on the first run at the file's date", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const no = uniqueNo("S7C");
      await importFile(
        tx,
        parseAt([{ orderNo: no, status: "Selesai", orderedAt: "2026-12-03 08:00", shippedAt: "2026-12-04 09:00", completedAt: "2026-12-08 12:00", lines: [{ sku: variant.sku, qty: 1, lineTotal: 249_000 }] }], new Date("2026-12-28T05:00:00Z")),
        staff.id,
      );
      const order = await shopeeOrder(tx, no);
      await postAll(tx);
      expect(await recognised(tx, order.id)).toMatchObject([{ entryDate: "2026-12-04", sourceDate: "2026-12-04" }]);
      expect(await openIssueCodes(tx, order.id)).toEqual([]);
    });
  });

  test("a ship date in a month closed meanwhile posts M1 into the first open month, keeping its source date (D-23)", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const no = uniqueNo("S7D");
      const lines = [{ sku: variant.sku, qty: 1, lineTotal: 249_000 }];
      const now = new Date("2027-02-10T05:00:00Z");
      await importFile(tx, parseAt([{ orderNo: no, status: "Dikirim", orderedAt: "2027-01-19 10:00", lines }], now), staff.id);
      const order = await shopeeOrder(tx, no);
      await postAll(tx);
      expect(await openIssueCodes(tx, order.id)).toEqual(["marketplace_ship_date_missing"]);

      // January closed with the issue still open (a reasoned override), then February's upload fills it.
      await tx.insert(fiscalPeriods).values({ month: "2027-01-01", status: "closed", closedAt: new Date(), closedByStaffUserId: staff.id });
      await importFile(tx, parseAt([{ orderNo: no, status: "Dikirim", orderedAt: "2027-01-19 10:00", shippedAt: "2027-01-20 23:30", lines }], now), staff.id);
      await postAll(tx);
      expect(await recognised(tx, order.id)).toMatchObject([{ kind: "system", entryDate: "2027-02-01", sourceDate: "2027-01-20" }]);
      expect(await openIssueCodes(tx, order.id)).toEqual([]);
    });
  });

  test("Perlu Dikirim with col 7 filled: no ship date is stored and nothing is recognised", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const no = uniqueNo("S7E");
      await importFile(tx, parseAt([{ orderNo: no, status: "Perlu Dikirim", orderedAt: "2026-12-19 10:00", shippedAt: "2026-12-20 08:00", lines: [{ sku: variant.sku, qty: 1, lineTotal: 249_000 }] }], new Date("2026-12-28T05:00:00Z")), staff.id);
      const order = await shopeeOrder(tx, no);
      expect(order).toMatchObject({ status: "to_ship", marketplaceShippedAt: null });
      await postAll(tx);
      expect(await recognised(tx, order.id)).toEqual([]);
      expect(await openIssueCodes(tx, order.id)).toEqual([]);
    });
  });
});

describe("Batal after shipping (owner 28 Nov 2026): the ship date is stored, M1 posts on it and S4 reverses it", () => {
  test("Dikirim without col 7, then Batal with col 7: returned, M1 on the ship date, S4 held behind it then posted, Saldo Penjual back to 0", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const no = uniqueNo("S7R");
      const lines = [{ sku: variant.sku, qty: 1, lineTotal: 249_000 }];
      const now = new Date("2026-12-28T05:00:00Z");
      await importFile(tx, parseAt([{ orderNo: no, status: "Dikirim", orderedAt: "2026-12-19 10:00", lines }], now), staff.id);
      const order = await shopeeOrder(tx, no);

      await importFile(tx, parseAt([{ orderNo: no, status: "Batal", orderedAt: "2026-12-19 10:00", shippedAt: "2026-12-20 23:30", lines }], now), staff.id);
      const returned = await shopeeOrder(tx, no);
      expect(returned).toMatchObject({ status: "returned", marketplaceShippedAt: new Date("2026-12-20T16:30:00Z") });

      await postAll(tx);
      expect(await recognised(tx, order.id)).toMatchObject([{ entryDate: "2026-12-20", sourceDate: "2026-12-20" }]);
      const s4 = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.sourceType, "order"), eq(journalEntries.sourceId, order.id), eq(journalEntries.sourceEvent, "returned")));
      expect(s4).toHaveLength(1);
      expect(await openIssueCodes(tx, order.id)).toEqual([]);
      // M1 debits Saldo Penjual, S4 claws it back: nothing is owed by Shopee for this order.
      const [saldo] = await tx
        .select({ net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
        .from(journalLines)
        .where(and(eq(journalLines.orderId, order.id), eq(journalLines.accountCode, "1-1302")));
      expect(Number(saldo?.net)).toBe(0);
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0 });
    });
  });
});

describe("opening 1-1505 proposal uses the recognition date (plan §19.9 7b)", () => {
  test("a Shopee order handed over in January per col 7 is still sold-not-shipped at the cut-over; one handed over in December, or shipped in the app before it without a ship time, is not", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const lines = [{ sku: variant.sku, qty: 1, lineTotal: 249_000 }];
      const now = new Date("2027-01-10T05:00:00Z");
      const january = uniqueNo("S7J");
      const december = uniqueNo("S7K");
      const noShipTime = uniqueNo("S7L");
      const amountOf = async () => (await proposeOpeningBalances(tx as never)).find((proposal) => proposal.key === "inventory.sold_not_shipped")?.amount ?? 0;
      const before = await amountOf();

      // Both are stocked out before the cut-over (the sale movement uses the database clock) and the app's
      // own shipped_at is the import time; only col 7 says when the parcel was handed over.
      await importFile(
        tx,
        parseAt(
          [
            { orderNo: january, status: "Dikirim", orderedAt: "2026-12-29 10:00", shippedAt: "2027-01-02 09:00", lines },
            { orderNo: december, status: "Dikirim", orderedAt: "2026-12-29 10:00", shippedAt: "2026-12-30 09:00", lines },
            // No ship time, shipped in the app before the cut-over: S3 treats it as recognised before the
            // books ("none") and never relieves 1-1505, so the opening must not hold its goods either.
            { orderNo: noShipTime, status: "Dikirim", orderedAt: "2026-11-20 10:00", lines },
          ],
          now,
        ),
        staff.id,
      );
      // The sale movements carry the database clock; pinned before the cut-over so the case always runs.
      // (stock_movements is append-only: its guard trigger is lifted for this one update, inside the rollback.)
      await withTriggerDisabled(tx, "stock_movements", "prevent_stock_movement_mutation", () =>
        tx.update(stockMovements).set({ createdAt: new Date("2026-12-29T03:00:00Z") }).where(and(eq(stockMovements.sku, variant.sku), eq(stockMovements.type, "sale"))),
      );
      // The app's shipped_at is the import time; pinned before the cut-over too, so the old rule
      // (o.shipped_at) would leave all three out.
      await tx
        .update(orders)
        .set({ shippedAt: new Date("2026-12-30T05:00:00Z") })
        .where(and(eq(orders.channelId, "shopee"), inArray(orders.channelOrderNo, [january, december, noShipTime])));
      expect((await amountOf()) - before).toBe(87_917);
    });
  });
});

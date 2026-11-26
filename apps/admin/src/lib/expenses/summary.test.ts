import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertOrder, insertProductVariant, insertStaffUser, shippingQuoteValues } from "@ammari/db/test-fixtures";
import {
  businessExpenses,
  costComponents,
  orderItems,
  privateFiles,
  purchases,
  salesGoal,
  supplierPayments,
  suppliers,
  type BusinessExpenseCategory,
  type ChannelId,
} from "@ammari/db/schema";
import { jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { createExpenseCategory, getExpenseCategoryCatalog, setExpenseCategoryActive } from "@/lib/expense-categories/queries";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { getChannelBreakdown, getPeriodTotals } from "@/lib/overview/queries";
import { createDraft, postBatch } from "@/lib/production/queries";
import { profitAndLossLines } from "./report-content";
import { buildRoasRows, labaBersih, monthRange } from "./figures";
import { dateRangeToTimeRange, getExpenseBreakdown, getExpenseSummary, getExpenseTotal, getMonthlyBillsReminder } from "./summary";

// docs/plans/growth.md §4 and §12.1 (session S3): expense figures from the database. Expenses are
// inserted directly (recordBusinessExpense refuses a future date) and dated in 2031, so whatever
// else ammari_test holds never falls inside a range under test.

const MONTH = monthRange("2031-03");

let expenseSeq = 0;

async function insertExpense(
  tx: TestDatabase,
  staffId: string,
  values: { expenseDate: string; category: BusinessExpenseCategory; amount: number; channelId?: ChannelId | null; voided?: boolean },
): Promise<string> {
  const fileId = randomUUID();
  const sha = createHash("sha256").update(fileId).digest("hex");
  await tx.insert(privateFiles).values({
    id: fileId,
    purpose: "expense_proof",
    storageKey: `test/expense_proof/2031/03/${fileId}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  });
  expenseSeq += 1;
  const [row] = await tx
    .insert(businessExpenses)
    .values({
      expenseNo: `BYA-TEST-${randomUUID().slice(0, 8)}-${expenseSeq}`,
      expenseDate: values.expenseDate,
      category: values.category,
      amount: values.amount,
      method: "transfer",
      channelId: values.channelId ?? null,
      note: values.category === "other" ? "uji" : null,
      proofFileId: fileId,
      recordedByStaffUserId: staffId,
    })
    .returning({ id: businessExpenses.id });
  if (!row) throw new Error("failed to insert expense");
  if (values.voided) {
    await tx
      .update(businessExpenses)
      .set({ voidedAt: new Date(), voidedByStaffUserId: staffId, voidReason: "Salah catat" })
      .where(eq(businessExpenses.id, row.id));
  }
  return row.id;
}

describe("dateRangeToTimeRange", () => {
  test("00:00 WIB on the first day to 00:00 WIB after the last, stopped at now", () => {
    const later = new Date("2032-01-01T00:00:00Z");
    expect(dateRangeToTimeRange(MONTH, later)).toEqual({ start: jakartaMidnight("2031-03-01"), end: jakartaMidnight("2031-04-01") });
    const midMonth = new Date("2031-03-10T05:00:00Z");
    expect(dateRangeToTimeRange(MONTH, midMonth)).toEqual({ start: jakartaMidnight("2031-03-01"), end: midMonth });
  });
});

describe("getExpenseBreakdown / getExpenseTotal (cash basis, voided never counts)", () => {
  test("by Jakarta payment date at the month edges; per category biggest first; marketing split", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await insertExpense(tx, staff.id, { expenseDate: "2031-02-28", category: "salary", amount: 9_000_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-01", category: "salary", amount: 4_000_000 });
      // Paid 31 March 23:30 WIB: the date on the proof is the 31st, so March.
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-31", category: "rent", amount: 1_500_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-04-01", category: "rent", amount: 7_000_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-15", category: "packaging", amount: 800_000, voided: true });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-05", category: "ads_shopee", amount: 300_000, channelId: "shopee" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-06", category: "ads_shopee", amount: 200_000, channelId: "shopee" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-07", category: "ads_meta", amount: 100_000, channelId: null });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-08", category: "ads_meta", amount: 150_000, channelId: "web" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-09", category: "endorsement", amount: 250_000, channelId: "instagram" });

      const breakdown = await getExpenseBreakdown(MONTH, tx);
      expect(breakdown.total).toBe(4_000_000 + 1_500_000 + 500_000 + 250_000 + 250_000);
      expect(breakdown.byCategory).toEqual([
        { category: "salary", amount: 4_000_000 },
        { category: "rent", amount: 1_500_000 },
        { category: "ads_shopee", amount: 500_000 },
        // A tie: the fixed category order decides (Iklan Meta before Endorse/KOL).
        { category: "ads_meta", amount: 250_000 },
        { category: "endorsement", amount: 250_000 },
      ]);
      expect(breakdown.marketing).toEqual({
        adSpendByChannel: { shopee: 500_000, web: 150_000 },
        untaggedAdSpend: 100_000,
        adSpendTotal: 750_000,
        endorsement: 250_000,
        marketingTotal: 1_000_000,
      });
      expect(await getExpenseTotal(MONTH, tx)).toBe(breakdown.total);
      expect(await getExpenseTotal({ from: "2031-03-01", to: "2031-03-01" }, tx)).toBe(4_000_000);
    });
  });

  test("an empty range is all zeros", async () => {
    await withRollback(async (tx) => {
      const breakdown = await getExpenseBreakdown(monthRange("2031-07"), tx);
      expect(breakdown).toEqual({
        total: 0,
        byCategory: [],
        marketing: { adSpendByChannel: {}, untaggedAdSpend: 0, adSpendTotal: 0, endorsement: 0, marketingTotal: 0 },
      });
      expect(await getExpenseTotal(monthRange("2031-07"), tx)).toBe(0);
    });
  });
});

describe("Laba bersih and ROAS on a fixture (plan §4.1)", () => {
  test("laba setelah biaya platform - web shipping subsidy - expenses; ROAS from the same omzet", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { variant } = await insertProductVariant(tx);
      const inMonth = new Date("2031-03-10T05:00:00Z");
      const order = async (values: Parameters<typeof insertOrder>[1], unitPrice: number, unitCost: number) => {
        const row = await insertOrder(tx, { orderDate: inMonth, subtotalAmount: unitPrice, ...values });
        await tx.insert(orderItems).values({ orderId: row.id, sku: variant.sku, qty: 1, unitPrice, unitCost });
      };
      // Shopee Rp 1.000.000 (HPP 400.000), web checkout Rp 300.000 (HPP 100.000, subsidy 20.000 of a
      // 35.000 quote), WhatsApp Rp 200.000 (HPP 80.000), and a cancelled web order whose subsidy
      // must not count.
      await order({ status: "completed", channelId: "shopee", channelOrderNo: `TEST-${randomUUID().slice(0, 8)}`, shippingAmount: 0 }, 1_000_000, 400_000);
      await order({ status: "completed", channelId: "web", channelOrderNo: null, ...shippingQuoteValues(35_000, 20_000) }, 300_000, 100_000);
      await order({ status: "shipped", channelId: "whatsapp", channelOrderNo: null }, 200_000, 80_000);
      await order({ status: "cancelled", channelId: "web", channelOrderNo: null, ...shippingQuoteValues(30_000, 20_000) }, 999_000, 1);

      await insertExpense(tx, staff.id, { expenseDate: "2031-03-02", category: "salary", amount: 400_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-03", category: "ads_shopee", amount: 100_000, channelId: "shopee" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-04", category: "ads_meta", amount: 50_000, channelId: "web" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-04", category: "endorsement", amount: 150_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-20", category: "rent", amount: 5_000_000, voided: true });

      const now = new Date("2032-01-01T00:00:00Z");
      const time = dateRangeToTimeRange(MONTH, now);
      const totals = await getPeriodTotals(time, { canViewProfit: true }, tx);
      const breakdown = await getExpenseBreakdown(MONTH, tx);
      const money = totals.money!;
      expect(money).toMatchObject({ omzet: 1_500_000, labaKotor: 920_000, platformFee: 0, labaSetelahBiayaPlatform: 920_000, webShippingSubsidy: 20_000 });
      // The Shopee order has no fee rows: "Biaya platform belum lengkap" carries over to Laba bersih.
      expect(money.platformFees.ordersWithoutFees).toBe(1);
      expect(breakdown.total).toBe(700_000);
      expect(labaBersih({ labaSetelahBiayaPlatform: money.labaSetelahBiayaPlatform, webShippingSubsidy: money.webShippingSubsidy, expenses: breakdown.total })).toBe(200_000);

      // getExpenseSummary (the tab and the monthly report) is exactly these figures.
      const summary = await getExpenseSummary(MONTH, now, tx);
      expect(summary.money).toEqual(money);
      expect(summary.expenses).toEqual(breakdown);
      expect(summary.net).toBe(200_000);
      expect(summary.incomplete).toBe(true);
      // Break-even: 1.500.000 / (920.000 - 20.000) = 1,67 -> 1,7.
      expect(summary.breakEven).toEqual({ kind: "computed", omzet: 1_500_000, contribution: 900_000, marginBps: 6_000, tenths: 17 });

      const channels = await getChannelBreakdown(time, { canViewProfit: true }, tx);
      expect(summary.channels).toEqual(channels);
      expect(summary.roasRows).toEqual(buildRoasRows(breakdown.marketing, new Map(channels.map((channel) => [channel.channelId, channel.omzet ?? 0])), summary.breakEven));
      const byKey = Object.fromEntries(summary.roasRows.map((row) => [row.key, row]));
      expect(byKey.shopee).toMatchObject({ adSpend: 100_000, omzet: 1_000_000, roasTenths: 100, status: "above" });
      expect(byKey.web).toMatchObject({ adSpend: 50_000, omzet: 300_000, roasTenths: 60, status: "above" });
      expect(byKey.total).toMatchObject({ adSpend: 150_000, omzet: 1_500_000, roasTenths: 100, status: "above" });
      expect(byKey.untagged).toBeUndefined();
    });
  });
});

describe("getMonthlyBillsReminder (owner answer A6: the categories chosen on /settings, paid 6th to 5th)", () => {
  // 09:00 WIB, 6 April 2031: last month is March, the window 6 Mar to 5 Apr.
  const ON_THE_6TH = new Date("2031-04-06T02:00:00Z");
  const WINDOW = { month: "2031-03", from: "2031-03-06", to: "2031-04-05" };

  async function choose(tx: TestDatabase, categories: BusinessExpenseCategory[]) {
    await tx.update(salesGoal).set({ monthlyBillCategories: categories }).where(eq(salesGoal.id, 1));
  }

  test("none chosen (the default): off, even from the 6th with nothing recorded", async () => {
    await withRollback(async (tx) => {
      await choose(tx, []);
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "off" });
    });
  });

  test("before the 6th: nothing missing, whatever was recorded", async () => {
    await withRollback(async (tx) => {
      await choose(tx, ["salary", "rent"]);
      expect(await getMonthlyBillsReminder(new Date("2031-04-05T10:00:00Z"), tx)).toEqual({ state: "ok", categories: ["salary", "rent"] });
    });
  });

  test("one chosen: missing until it has its own expense in the window; other categories never count", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await choose(tx, ["utilities"]);
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-10", category: "salary", amount: 100_000 });
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "missing", ...WINDOW, missing: ["utilities"] });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-20", category: "utilities", amount: 300_000 });
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "ok", categories: ["utilities"] });
    });
  });

  test("several chosen, partly recorded: names only the missing ones, in their saved order", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await choose(tx, ["salary", "rent", "utilities"]);
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "missing", ...WINDOW, missing: ["salary", "rent", "utilities"] });
      // Sewa paid on the last day of March (end of month).
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-31", category: "rent", amount: 1_500_000 });
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "missing", ...WINDOW, missing: ["salary", "utilities"] });
      // Gaji paid on 5 April (early next month, the window's last day) and Utilitas on 6 March (its first).
      await insertExpense(tx, staff.id, { expenseDate: "2031-04-05", category: "salary", amount: 4_000_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-06", category: "utilities", amount: 1 });
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "ok", categories: ["salary", "rent", "utilities"] });
    });
  });

  test("last month's early payment (1st to 5th: the month before's bills), anything after the 5th, and voided ones do not count", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await choose(tx, ["salary", "rent"]);
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-01", category: "salary", amount: 1 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-05", category: "rent", amount: 1 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-04-06", category: "salary", amount: 1 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-04-01", category: "rent", amount: 1, voided: true });
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "missing", ...WINDOW, missing: ["salary", "rent"] });
    });
  });
});

/** Three counted orders in March 2031 (omzet 1.500.000, laba setelah biaya platform 920.000,
 * subsidy 20.000), the same as the Laba bersih fixture above. */
async function ordersFixture(tx: TestDatabase) {
  const { variant } = await insertProductVariant(tx);
  const inMonth = new Date("2031-03-10T05:00:00Z");
  const order = async (values: Parameters<typeof insertOrder>[1], unitPrice: number, unitCost: number) => {
    const row = await insertOrder(tx, { orderDate: inMonth, subtotalAmount: unitPrice, ...values });
    await tx.insert(orderItems).values({ orderId: row.id, sku: variant.sku, qty: 1, unitPrice, unitCost });
  };
  await order({ status: "completed", channelId: "shopee", channelOrderNo: `TEST-${randomUUID().slice(0, 8)}`, shippingAmount: 0 }, 1_000_000, 400_000);
  await order({ status: "completed", channelId: "web", channelOrderNo: null, ...shippingQuoteValues(35_000, 20_000) }, 300_000, 100_000);
  await order({ status: "shipped", channelId: "whatsapp", channelOrderNo: null }, 200_000, 80_000);
}

describe("categories come from expense_categories (docs/plans/expense-master-data.md S2)", () => {
  test("an owner-made ad category counts in biaya iklan and ROAS; an owner-made operating one is its own P&L line and lowers Laba bersih", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await ordersFixture(tx);
      const suffix = randomUUID().slice(0, 6);
      const google = await createExpenseCategory({ name: `Iklan Google ${suffix}`, kind: "ad", sortOrder: 50 }, null, tx);
      const langganan = await createExpenseCategory({ name: `Langganan ${suffix}`, kind: "operating", sortOrder: 160 }, null, tx);
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-02", category: "salary", amount: 400_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-03", category: langganan.code, amount: 200_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-04", category: google.code, amount: 70_000, channelId: "web" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-05", category: google.code, amount: 30_000 });

      const now = new Date("2032-01-01T00:00:00Z");
      const summary = await getExpenseSummary(MONTH, now, tx);
      expect(summary.expenses.total).toBe(700_000);
      expect(summary.expenses.byCategory).toEqual([
        { category: "salary", amount: 400_000 },
        { category: langganan.code, amount: 200_000 },
        { category: google.code, amount: 100_000 },
      ]);
      // kind = ad: tagged spend per channel, untagged only in the total; nothing in Endorse.
      expect(summary.expenses.marketing).toEqual({ adSpendByChannel: { web: 70_000 }, untaggedAdSpend: 30_000, adSpendTotal: 100_000, endorsement: 0, marketingTotal: 100_000 });
      const byKey = Object.fromEntries(summary.roasRows.map((row) => [row.key, row]));
      expect(byKey.web).toMatchObject({ adSpend: 70_000, omzet: 300_000, roasTenths: 43 });
      expect(byKey.untagged).toMatchObject({ adSpend: 30_000 });
      expect(byKey.total).toMatchObject({ adSpend: 100_000, omzet: 1_500_000, roasTenths: 150 });
      // Laba bersih = 920.000 - 20.000 - 700.000.
      expect(summary.net).toBe(200_000);

      const { categories } = await getExpenseCategoryCatalog(tx);
      const lines = profitAndLossLines(summary, categories);
      expect(lines.filter((line) => line.kind === "detail")).toEqual([
        { label: "Gaji", amount: -400_000, kind: "detail" },
        { label: `Langganan ${suffix}`, amount: -200_000, kind: "detail" },
        { label: `Iklan Google ${suffix}`, amount: -100_000, kind: "detail" },
      ]);
      expect(lines.at(-1)).toEqual({ label: "Laba bersih", amount: 200_000, kind: "result" });
    });
  });

  test("a deactivated category still counts in the figures of the months it was paid in", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const category = await createExpenseCategory({ name: `Sewa Gudang ${randomUUID().slice(0, 6)}`, kind: "operating", sortOrder: 145 }, null, tx);
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-02", category: category.code, amount: 123_000 });
      await setExpenseCategoryActive(category.code, false, null, tx);
      expect((await getExpenseBreakdown(MONTH, tx)).byCategory).toEqual([{ category: category.code, amount: 123_000 }]);
      expect(await getExpenseTotal(MONTH, tx)).toBe(123_000);
    });
  });
});

describe("getMonthlyBillsReminder with the catalog (owner answer D3)", () => {
  const ON_THE_6TH = new Date("2031-04-06T02:00:00Z");

  test("any category may be a monthly bill; a deactivated one drops out, and only deactivated ones is off", async () => {
    await withRollback(async (tx) => {
      const category = await createExpenseCategory({ name: `Langganan ${randomUUID().slice(0, 6)}`, kind: "operating", sortOrder: 160 }, null, tx);
      await tx.update(salesGoal).set({ monthlyBillCategories: ["salary", category.code, "ads_meta"] }).where(eq(salesGoal.id, 1));
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toMatchObject({ state: "missing", missing: ["salary", category.code, "ads_meta"] });

      await setExpenseCategoryActive(category.code, false, null, tx);
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toMatchObject({ state: "missing", missing: ["salary", "ads_meta"] });
      expect(await getMonthlyBillsReminder(new Date("2031-04-05T10:00:00Z"), tx)).toEqual({ state: "ok", categories: ["salary", "ads_meta"] });

      await tx.update(salesGoal).set({ monthlyBillCategories: [category.code] }).where(eq(salesGoal.id, 1));
      expect(await getMonthlyBillsReminder(ON_THE_6TH, tx)).toEqual({ state: "off" });
    });
  });
});

function proofFileValues(staffId: string, purpose: "expense_proof" | "payment_proof") {
  const id = randomUUID();
  const sha = createHash("sha256").update(id).digest("hex");
  return {
    id,
    purpose,
    storageKey: `test/${purpose}/2031/03/${id}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  } as const;
}

describe("accounting guard (expense-master-data.md §3.11): supplier payments never reach the expense figures", () => {
  test("purchase and production batch payments in the month change no Laba bersih, expense total, P&L line, ROAS, break-even or Overview tile", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await ordersFixture(tx);
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-02", category: "salary", amount: 400_000 });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-03", category: "ads_shopee", amount: 100_000, channelId: "shopee" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-04", category: "ads_meta", amount: 50_000, channelId: "web" });
      await insertExpense(tx, staff.id, { expenseDate: "2031-03-04", category: "endorsement", amount: 150_000 });

      // A purchase and a posted production batch with a service line, both payable.
      const [supplier] = await tx.insert(suppliers).values({ name: `Pemasok Uji ${randomUUID().slice(0, 8)}` }).returning();
      const [purchase] = await tx
        .insert(purchases)
        .values({ purchaseNo: `PO-203103-${randomUUID().slice(0, 4)}`, supplierId: supplier!.id, orderedAt: "2031-03-01", createdByStaffUserId: staff.id })
        .returning();
      const { fabric, variant } = await insertProductVariant(tx);
      const [sewing] = await tx.insert(costComponents).values({ name: `Ongkos jahit ${randomUUID().slice(0, 8)}`, unit: "pcs", costType: "variable" }).returning();
      await recordFabricPurchase({ fabricId: fabric!.id, qty: 10, totalAmountPaid: 1_000_000, purchasedAt: "2026-09-01" }, null, tx);
      const batch = await createDraft(
        {
          fabricId: fabric!.id,
          producedAt: "2026-10-01",
          fabricYards: 10,
          fabricUsages: [{ fabricColorId: null, yards: 10 }],
          lines: [{ sku: variant!.sku, qty: 10 }],
          extraCosts: [{ costComponentId: sewing!.id, unitPrice: 20_000, supplierId: supplier!.id }],
        },
        staff.id,
        tx,
      );
      await postBatch(batch.id, staff.id, tx);

      const now = new Date("2032-01-01T00:00:00Z");
      const snapshot = async () => {
        const summary = await getExpenseSummary(MONTH, now, tx);
        const { categories } = await getExpenseCategoryCatalog(tx);
        return {
          net: summary.net,
          expenses: summary.expenses,
          roasRows: summary.roasRows,
          breakEven: summary.breakEven,
          lines: profitAndLossLines(summary, categories),
          overviewTile: await getExpenseTotal(MONTH, tx),
        };
      };
      const before = await snapshot();
      expect(before.net).toBe(200_000);
      expect(before.expenses.total).toBe(700_000);

      // Non-voided payments paid inside the month: a purchase (DP and the rest) and the batch.
      let seq = 0;
      const payment = async (values: Partial<typeof supplierPayments.$inferInsert>, amount: number) => {
        const file = proofFileValues(staff.id, "payment_proof");
        await tx.insert(privateFiles).values(file);
        seq += 1;
        await tx.insert(supplierPayments).values({
          paymentNo: `BYR-TEST-${randomUUID().slice(0, 8)}-${seq}`,
          paidAt: "2031-03-15",
          amount,
          method: "transfer",
          proofFileId: file.id,
          recordedByStaffUserId: staff.id,
          supplierId: supplier!.id,
          supplierName: supplier!.name,
          ...values,
        } as typeof supplierPayments.$inferInsert);
      };
      await payment({ targetType: "purchase", purchaseId: purchase!.id }, 3_000_000);
      await payment({ targetType: "purchase", purchaseId: purchase!.id }, 2_000_000);
      await payment({ targetType: "production_batch", productionBatchId: batch.id }, 200_000);

      const after = await snapshot();
      expect(after).toEqual(before);
      expect(after.lines.map((line) => line.label)).not.toContain("Biaya produksi");
    });
  });
});

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertOrder, insertProductVariant, insertStaffUser, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { auditLog, businessExpenses, orderChannelFees, orderItems, privateFiles, type BusinessExpenseCategory, type ChannelId } from "@ammari/db/schema";
import { getMonthlyReport, recordMonthlyReportDownload } from "./report";
import { renderMonthlyReportPdf } from "./report-pdf";
import { renderMonthlyReportXlsx } from "./report-xlsx";
import { parseExpenseSummaryParams } from "./search-params";

// "Unduh laporan bulanan" (docs/plans/growth.md session S6, owner addition A): the rows behind the
// Ringkasan add up to its figures, both files carry them, and the download is audited without a
// figure. Dated in 2032, so whatever else ammari_test holds never falls inside the month.

const NOW = new Date("2033-01-01T00:00:00Z");
const PARAMS = parseExpenseSummaryParams({ period: "month", month: "2032-05" }, NOW);

async function insertExpense(tx: TestDatabase, staffId: string, values: { expenseDate: string; category: BusinessExpenseCategory; amount: number; channelId?: ChannelId | null; note?: string; voided?: boolean }) {
  const fileId = randomUUID();
  const sha = createHash("sha256").update(fileId).digest("hex");
  await tx.insert(privateFiles).values({
    id: fileId,
    purpose: "expense_proof",
    storageKey: `test/expense_proof/2032/05/${fileId}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  });
  const [row] = await tx
    .insert(businessExpenses)
    .values({
      expenseNo: `BYA-RPT-${randomUUID().slice(0, 8)}`,
      expenseDate: values.expenseDate,
      category: values.category,
      amount: values.amount,
      method: "transfer",
      channelId: values.channelId ?? null,
      note: values.note ?? null,
      proofFileId: fileId,
      recordedByStaffUserId: staffId,
      ...(values.voided ? { voidedAt: new Date(), voidedByStaffUserId: staffId, voidReason: "Salah catat" } : {}),
    })
    .returning({ id: businessExpenses.id, expenseNo: businessExpenses.expenseNo });
  return row!;
}

async function seedMonth(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const { variant } = await insertProductVariant(tx);
  const day = new Date("2032-05-10T05:00:00Z");
  const order = async (values: Parameters<typeof insertOrder>[1], unitPrice: number, unitCost: number) => {
    const row = await insertOrder(tx, { orderDate: day, subtotalAmount: unitPrice, ...values });
    await tx.insert(orderItems).values({ orderId: row.id, sku: variant.sku, qty: 1, unitPrice, unitCost });
    return row;
  };
  const shopee = await order({ status: "completed", channelId: "shopee", channelOrderNo: `RPT-${randomUUID().slice(0, 8)}`, shippingAmount: 0 }, 1_000_000, 400_000);
  await tx.insert(orderChannelFees).values({ orderId: shopee.id, component: "admin_fee", amount: 50_000 });
  await order({ status: "completed", channelId: "web", channelOrderNo: null, ...shippingQuoteValues(35_000, 20_000) }, 300_000, 100_000);
  await order({ status: "shipped", channelId: "whatsapp", channelOrderNo: null }, 200_000, 0);
  await order({ status: "cancelled", channelId: "whatsapp", channelOrderNo: null }, 999_000, 1);
  // A note a spreadsheet would run as a formula.
  const formula = await insertExpense(tx, staff.id, { expenseDate: "2032-05-02", category: "other", amount: 100_000, note: "=HYPERLINK(\"http://x\")" });
  await insertExpense(tx, staff.id, { expenseDate: "2032-05-03", category: "ads_shopee", amount: 100_000, channelId: "shopee" });
  await insertExpense(tx, staff.id, { expenseDate: "2032-05-04", category: "rent", amount: 5_000_000, voided: true });
  await insertExpense(tx, staff.id, { expenseDate: "2032-06-01", category: "rent", amount: 7_000_000 });
  return { staff, formula };
}

describe("getMonthlyReport", () => {
  test("rows add up to the Ringkasan figures; voided and other months left out", async () => {
    await withRollback(async (tx) => {
      await seedMonth(tx);
      const report = await getMonthlyReport(PARAMS, NOW, tx);
      const { money, expenses } = report.summary;
      expect(money).toMatchObject({ omzet: 1_500_000, hpp: 500_000, platformFee: 50_000, labaSetelahBiayaPlatform: 950_000, webShippingSubsidy: 20_000, linesWithoutCost: 1 });
      expect(report.expenseRows.map((row) => row.category)).toEqual(["other", "ads_shopee"]);
      expect(report.expenseRows.reduce((sum, row) => sum + row.amount, 0)).toBe(expenses.total);
      expect(report.expenseRows[0]).toMatchObject({ recordedByName: "Test Staff", method: "transfer" });
      expect(report.orderRows).toHaveLength(3);
      const sum = (key: "omzet" | "hpp" | "platformFee" | "webShippingSubsidy") => report.orderRows.reduce((total, row) => total + row[key], 0);
      expect([sum("omzet"), sum("hpp"), sum("platformFee"), sum("webShippingSubsidy")]).toEqual([money.omzet, money.hpp, money.platformFee, money.webShippingSubsidy]);
      expect(report.orderRows.find((row) => row.channelId === "whatsapp")).toMatchObject({ linesWithoutCost: 1, feeMissing: false });
      expect(report.ordersTruncated).toBe(false);
      expect(report.summary.net).toBe(950_000 - 20_000 - 200_000);
      // 1.500.000 / 930.000 = 1,6.
      expect(report.summary.breakEven).toMatchObject({ kind: "computed", tenths: 16 });
    });
  });
});

describe("the files", () => {
  test("Excel: four sheets with the same figures, money as numbers, a formula-looking note as inert text", async () => {
    await withRollback(async (tx) => {
      const { formula } = await seedMonth(tx);
      const report = await getMonthlyReport(PARAMS, NOW, tx);
      const workbook = XLSX.read(renderMonthlyReportXlsx(report, "2033-01-01"), { type: "buffer" });
      expect(workbook.SheetNames).toEqual(["Ringkasan", "Per kanal", "Biaya", "Pesanan"]);

      const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets.Ringkasan!, { header: 1 });
      expect(summary[0]).toEqual(["Laporan Keuangan Mei 2032"]);
      const line = (label: string) => summary.find((row) => row[0] === label)?.[1];
      expect(line("Omzet")).toBe(1_500_000);
      expect(line("HPP")).toBe(-500_000);
      expect(line("Laba bersih")).toBe(report.summary.net);
      expect(summary.flat()).toContain("Laporan manajemen, bukan laporan keuangan resmi.");

      const expenses = workbook.Sheets.Biaya!;
      const rows = XLSX.utils.sheet_to_json<(string | number)[]>(expenses, { header: 1 });
      expect(rows[0]).toEqual(["Tanggal bayar", "No. biaya", "Kategori", "Kanal", "Kampanye", "Jumlah (Rp)", "Metode", "Catatan", "Dicatat oleh"]);
      const formulaRow = rows.find((row) => row[1] === formula.expenseNo)!;
      expect(formulaRow[7]).toBe("'=HYPERLINK(\"http://x\")");
      // No cell anywhere is a formula.
      for (const name of workbook.SheetNames) {
        const sheet = workbook.Sheets[name]!;
        for (const [address, cell] of Object.entries(sheet)) if (!address.startsWith("!")) expect((cell as XLSX.CellObject).f).toBeUndefined();
      }
      expect([rows.at(-1)?.[0], rows.at(-1)?.[5]]).toEqual(["Total", 200_000]);

      const orders = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets.Pesanan!, { header: 1 });
      expect(orders).toHaveLength(1 + 3 + 2);
      expect(orders.at(-1)?.slice(3, 7)).toEqual([1_500_000, 500_000, 50_000, 20_000]);
      expect(orders.find((row) => row[2] === "WhatsApp")?.[7]).toBe("HPP belum lengkap");

      const channels = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets["Per kanal"]!, { header: 1 });
      expect(channels.find((row) => row[0] === "Shopee")).toEqual(["Shopee", 1_000_000, 1, 100_000, "10,0", "Di atas titik impas"]);
    });
  });

  test("PDF: one A4 page with the title in its metadata, with and without the logo", async () => {
    await withRollback(async (tx) => {
      await seedMonth(tx);
      const report = await getMonthlyReport(PARAMS, NOW, tx);
      const { readFile } = await import("node:fs/promises");
      const logo = await readFile(new URL("../../../public/logos/ammari-mark-512.png", import.meta.url));
      for (const bytes of [await renderMonthlyReportPdf(report, "2033-01-01", logo), await renderMonthlyReportPdf(report, "2033-01-01", null)]) {
        expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
        const pdf = await PDFDocument.load(bytes);
        expect(pdf.getPageCount()).toBe(1);
        expect(pdf.getTitle()).toBe("Laporan Keuangan Mei 2032");
        const { width, height } = pdf.getPage(0).getSize();
        expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
      }
    });
  });
});

describe("recordMonthlyReportDownload", () => {
  test("audits the period, format and counts, never a figure", async () => {
    await withRollback(async (tx) => {
      const { staff } = await seedMonth(tx);
      const report = await getMonthlyReport(PARAMS, NOW, tx);
      await recordMonthlyReportDownload(staff.id, report, "xlsx", tx);
      const [row] = await tx
        .select({ entityId: auditLog.entityId, after: auditLog.after })
        .from(auditLog)
        .where(and(eq(auditLog.actorStaffUserId, staff.id), eq(auditLog.entityType, "expense_report"), eq(auditLog.action, "download")));
      expect(row).toEqual({
        entityId: "2032-05..2032-05",
        after: { format: "xlsx", fromMonth: "2032-05", toMonth: "2032-05", expenseRows: 2, orderRows: 3, ordersTruncated: false },
      });
    });
  });
});

import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { getStaffSession } from "@/lib/auth/staff-session";
import { getMonthlyReport, recordMonthlyReportDownload, type ReportFormat } from "@/lib/expenses/report";
import { reportFileName } from "@/lib/expenses/report-content";
import { loadReportLogo, renderMonthlyReportPdf } from "@/lib/expenses/report-pdf";
import { renderMonthlyReportXlsx } from "@/lib/expenses/report-xlsx";
import { parseExpenseSummaryParams } from "@/lib/expenses/search-params";

// "Unduh laporan bulanan" (docs/plans/growth.md session S6, owner addition A): the Ringkasan tab's
// period (same `period` / `month` / `from` / `to` params, same parser, so an invalid period is this
// month exactly as on screen) as a PDF or an Excel file. Needs ads_expenses.manage AND
// finance.view_profit, checked here (CLAUDE.md: every route handler), before anything is read.
// Every download is audited (expense_report / download). Never cached.

const CONTENT_TYPES: Record<ReportFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: Request): Promise<Response> {
  const session = await getStaffSession();
  if (!session) return plain(401, "Unauthorized");
  if (!session.permissionKeys.includes("ads_expenses.manage") || !session.permissionKeys.includes("finance.view_profit")) return plain(403, "Forbidden");

  const search = new URL(request.url).searchParams;
  const rawFormat = search.get("format");
  if (rawFormat !== "pdf" && rawFormat !== "xlsx") return plain(400, "Unknown format");
  const format: ReportFormat = rawFormat;

  const now = new Date();
  const params = parseExpenseSummaryParams(Object.fromEntries(["period", "month", "from", "to"].map((key) => [key, search.get(key) ?? undefined])), now);
  const today = jakartaDate(now);
  const report = await getMonthlyReport(params, now);
  const body = format === "pdf" ? await renderMonthlyReportPdf(report, today, await loadReportLogo()) : renderMonthlyReportXlsx(report, today);
  // Audited once the file exists: a download that failed to build is not one.
  await recordMonthlyReportDownload(session.staffUser.id, report, format);

  return new Response(Buffer.from(body), {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${reportFileName(params, format)}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { getStaffSession } from "@/lib/auth/staff-session";
import { parseDateRange } from "@/lib/accounting/filters";
import { getTrialBalance, recordTrialBalanceDownload, type TrialBalanceFormat } from "@/lib/accounting/trial-balance";
import { trialBalanceFileName } from "@/lib/accounting/trial-balance-content";
import { renderTrialBalancePdf } from "@/lib/accounting/trial-balance-pdf";
import { renderTrialBalanceXlsx } from "@/lib/accounting/trial-balance-xlsx";

// "Unduh PDF / Excel" of Neraca saldo (docs/plans/accounting.md §6, Session 4): the page's range
// (same parser, same one-set-of-books rule). Needs accounting.view, checked here before anything is
// read (CLAUDE.md: every route handler). Every download is audited. Never cached.

const CONTENT_TYPES: Record<TrialBalanceFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: Request): Promise<Response> {
  const session = await getStaffSession();
  if (!session) return plain(401, "Unauthorized");
  if (!session.permissionKeys.includes("accounting.view")) return plain(403, "Forbidden");

  const search = new URL(request.url).searchParams;
  const rawFormat = search.get("format");
  if (rawFormat !== "pdf" && rawFormat !== "xlsx") return plain(400, "Unknown format");
  const format: TrialBalanceFormat = rawFormat;

  const report = await getTrialBalance(parseDateRange({ from: search.get("from") ?? undefined, to: search.get("to") ?? undefined }, jakartaDate()));
  const body = format === "pdf" ? await renderTrialBalancePdf(report) : renderTrialBalanceXlsx(report);
  // Audited once the file exists: a download that failed to build is not one.
  await recordTrialBalanceDownload(session.staffUser.id, report, format);

  return new Response(Buffer.from(body), {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${trialBalanceFileName(report.range, format)}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

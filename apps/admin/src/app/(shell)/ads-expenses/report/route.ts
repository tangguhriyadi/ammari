import { legacyReportHref } from "@/lib/expenses/legacy-redirect";

// The old "Unduh laporan bulanan" URL (docs/plans/expense-master-data.md §3.8, session S5): a 308
// to /expenses/report with the query string unchanged. No permission check here and nothing is
// read: the target route checks ads_expenses.manage + finance.view_profit before anything else.
// A relative Location, so the redirect never names the internal host behind the proxy.

export function GET(request: Request): Response {
  return new Response(null, { status: 308, headers: { Location: legacyReportHref(new URL(request.url).search), "Cache-Control": "no-store" } });
}

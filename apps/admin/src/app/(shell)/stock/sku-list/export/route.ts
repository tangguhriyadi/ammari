import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { sizeLabel } from "@ammari/commerce/size-label";
import { getStaffSession } from "@/lib/auth/staff-session";
import { buildCsv } from "@/lib/csv";
import { listSkus, skuListFilters, skuListTable } from "@/lib/stock/sku-list";

// "Unduh CSV" of Daftar SKU (docs/plans/marketplace-import.md §11.1): the same rows and filters as
// the page. The permission is checked here, not only on the page (CLAUDE.md: every route handler);
// proxy.ts already sends a request without a session to /login, the 401 is this route's own guard.

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: Request): Promise<Response> {
  const session = await getStaffSession();
  if (!session) return plain(401, "Unauthorized");
  if (!session.permissionKeys.includes("stock.view")) return plain(403, "Forbidden");

  const params = new URL(request.url).searchParams;
  const { rows } = await listSkus(skuListFilters({ q: params.get("q"), status: params.get("status") }));
  const csv = buildCsv(skuListTable(rows, sizeLabel));

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="daftar-sku-${jakartaDate()}.csv"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

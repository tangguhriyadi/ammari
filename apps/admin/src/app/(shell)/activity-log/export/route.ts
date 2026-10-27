import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { formatDateTime } from "@ammari/ui/lib";
import { getStaffSession } from "@/lib/auth/staff-session";
import { buildCsv, type SpreadsheetCell } from "@/lib/csv";
import { parseActivityLogFilters } from "@/lib/activity-log/filters";
import { EXPORT_ROW_CAP, exportActivityLogRows, recordActivityLogExport, type ActivityLogRow } from "@/lib/activity-log/queries";

// "Unduh CSV" of Log Aktivitas (docs/plans/activity-log.md §3): the page's filters, summary
// columns only (never the before/after payloads), at most EXPORT_ROW_CAP rows. The download is
// itself audited. The permission is checked here, not only on the page (CLAUDE.md: every route
// handler); proxy.ts already sends a request without a session to /login.

const HEADER = ["Waktu (WIB)", "Pelaku", "Email pelaku", "Aktivitas", "Bagian", "Jenis data", "Data", "Kode aktivitas", "ID data"];

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function csvRow(row: ActivityLogRow): SpreadsheetCell[] {
  const actorName = row.actor.kind === "staff" ? row.actor.name : row.actor.label;
  const actorEmail = row.actor.kind === "staff" ? row.actor.email : null;
  return [formatDateTime(row.createdAt), actorName, actorEmail, row.actionLabel, row.areaLabel, row.entity.typeLabel, row.entity.label, `${row.entityType}/${row.action}`, row.entityId];
}

export async function GET(request: Request): Promise<Response> {
  const session = await getStaffSession();
  if (!session) return plain(401, "Unauthorized");
  if (!session.permissionKeys.includes("audit_log.view")) return plain(403, "Forbidden");

  const params = new URL(request.url).searchParams;
  const filters = parseActivityLogFilters({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    actor: params.get("actor") ?? undefined,
    area: params.get("area") ?? undefined,
    q: params.get("q") ?? undefined,
  });
  const { rows, truncated } = await exportActivityLogRows(filters, EXPORT_ROW_CAP);
  await recordActivityLogExport(session.staffUser.id, filters, rows.length, truncated);

  const table: SpreadsheetCell[][] = [HEADER, ...rows.map(csvRow)];
  if (truncated) table.push([`Dipotong: hanya ${EXPORT_ROW_CAP} baris terbaru. Persempit tanggal atau filter untuk sisanya.`]);

  return new Response(buildCsv(table), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="log-aktivitas-${filters.from}-sd-${filters.to}-${jakartaDate()}.csv"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

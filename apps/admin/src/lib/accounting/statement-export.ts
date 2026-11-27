import "server-only";
import { getStaffSession } from "@/lib/auth/staff-session";
import { statementFileName } from "./statement-content";
import { renderStatementPdf } from "./statement-pdf";
import { renderStatementXlsx } from "./statement-xlsx";
import { recordStatementDownload, type StatementFormat, type StatementReport } from "./statements";

// "Unduh PDF / Excel" of Neraca, Laba rugi and Arus kas (docs/plans/accounting.md §6, Session 10),
// the same contract as the Neraca saldo export: accounting.view checked here before anything is read
// (CLAUDE.md: every route handler), the page's own parser and set-of-books rule, every download
// audited once the file exists, never cached.

const CONTENT_TYPES: Record<StatementFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function statementExportResponse(request: Request, load: (search: URLSearchParams) => Promise<StatementReport>): Promise<Response> {
  const session = await getStaffSession();
  if (!session) return plain(401, "Unauthorized");
  if (!session.permissionKeys.includes("accounting.view")) return plain(403, "Forbidden");

  const search = new URL(request.url).searchParams;
  const rawFormat = search.get("format");
  if (rawFormat !== "pdf" && rawFormat !== "xlsx") return plain(400, "Unknown format");
  const format: StatementFormat = rawFormat;

  const report = await load(search);
  const body = format === "pdf" ? await renderStatementPdf(report) : renderStatementXlsx(report);
  await recordStatementDownload(session.staffUser.id, report, format);

  return new Response(Buffer.from(body), {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${statementFileName(report, format)}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Search params as the page's parsers take them (a missing value is undefined, never null). */
export function searchValue(search: URLSearchParams, name: string): string | undefined {
  return search.get(name) ?? undefined;
}

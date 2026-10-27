import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { formatDateTime } from "@ammari/ui/lib";
import { getStaffSession } from "@/lib/auth/staff-session";
import { buildCsv, type SpreadsheetCell } from "@/lib/csv";
import { listPromoContacts, recordPromoContactExport } from "@/lib/customers/promo-export";

// "Unduh kontak promo" (docs/plans/growth.md §10, owner answer A9): customers.view AND
// customers.export (owner and super_admin only; never CS or Keuangan), checked here before
// anything is read. `ack=1` is the dialog's "Saya paham ..." tick: refused without it, so a bare
// link can never skip the warning. CSV, never cached, audited with the row count only.

const HEADER = ["Nama", "Email", "Nomor HP", "Setuju promo sejak (WIB)"];

/** "+6281234567890" -> "6281234567890": the form WhatsApp tools import, and it needs no formula
 * guard (a leading "+" would get the CSV's apostrophe and break the number). Every stored phone
 * matches ^\+62[0-9]{8,13}$ (customers_phone_format_check), so only the "+" goes. */
function exportPhone(phone: string | null): string | null {
  return phone === null ? null : phone.replace(/^\+/, "");
}

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: Request): Promise<Response> {
  const session = await getStaffSession();
  if (!session) return plain(401, "Unauthorized");
  if (!session.permissionKeys.includes("customers.view") || !session.permissionKeys.includes("customers.export")) return plain(403, "Forbidden");
  if (new URL(request.url).searchParams.get("ack") !== "1") return plain(400, "Centang pernyataan penggunaan data dulu.");

  const contacts = await listPromoContacts();
  const table: SpreadsheetCell[][] = [HEADER, ...contacts.map((contact) => [contact.name, contact.email, exportPhone(contact.phone), formatDateTime(contact.promoConsentAt)])];
  const csv = buildCsv(table);
  // Audited once the file exists, as the monthly report.
  await recordPromoContactExport(session.staffUser.id, contacts.length);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kontak-promo-${jakartaDate()}.csv"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

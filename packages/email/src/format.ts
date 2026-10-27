// Text helpers shared by every email (docs/plans/email-design.md). Times are always WIB
// (Asia/Jakarta), whatever the server's own zone.

const JAKARTA_DATE = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric" });
const JAKARTA_TIME = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "21 Oktober 2026, 14.30 WIB". */
export function formatWib(date: Date): string {
  return `${JAKARTA_DATE.format(date)}, ${JAKARTA_TIME.format(date)} WIB`;
}

/** "14.30 WIB". */
export function formatWibTime(date: Date): string {
  return `${JAKARTA_TIME.format(date)} WIB`;
}

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

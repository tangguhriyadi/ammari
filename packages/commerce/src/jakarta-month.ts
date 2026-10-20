const JAKARTA_YEAR_MONTH_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
});

/** "YYYYMM" in Asia/Jakarta — e.g. 2026-10-31T17:30:00Z (= 00:30 WIB on 1 November) -> "202611".
 * Used for both the batch-number prefix and its advisory-lock key, so the two always agree on
 * which "month" a batch belongs to. */
export function jakartaYearMonth(now: Date = new Date()): string {
  const parts = JAKARTA_YEAR_MONTH_FORMATTER.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("failed to format Jakarta year/month");
  return `${year}${month}`;
}

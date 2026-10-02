const JAKARTA_ISO_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "Today" in Asia/Jakarta as "YYYY-MM-DD" (en-CA formats dates in ISO order) — for comparing
 * against a `date`-mode-string column like cost_assumptions.effective_from. */
export function todayInJakarta(now: Date = new Date()): string {
  return JAKARTA_ISO_DATE_FORMATTER.format(now);
}

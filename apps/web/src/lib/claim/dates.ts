import "server-only";

const JAKARTA_YMD_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function jakartaYmd(date: Date): { year: number; month: number; day: number } {
  const parts = JAKARTA_YMD_FORMATTER.formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  return { year, month, day };
}

/** `claimedAt` (Asia/Jakarta calendar date) + 3 calendar months, 23:59:59 WIB (docs/SPEC.md
 * §4.4), clamped to the last day of the TARGET month when the source day doesn't exist there.
 * Same clamping approach as apps/admin's `claimDeadlineFromOrderDate`
 * (apps/admin/src/lib/packing/queries.ts), generalized to an arbitrary month offset and applied
 * to the claim date instead of the order date (approved plan decision — voucher expiry is
 * computed from when the voucher was actually claimed, not when the source order was placed). */
export function voucherExpiresAt(claimedAt: Date): Date {
  const { year, month, day } = jakartaYmd(claimedAt);
  let targetYear = year;
  let targetMonth = month + 3;
  while (targetMonth > 12) {
    targetMonth -= 12;
    targetYear += 1;
  }
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  const mm = String(targetMonth).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return new Date(`${targetYear}-${mm}-${dd}T23:59:59+07:00`);
}

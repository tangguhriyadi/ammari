import { isCalendarDate, monthEndOf, nextMonthStart, OFFICIAL_BOOKS_START, TRIAL_BOOKS_START } from "@ammari/accounting";

// Month close rules (docs/plans/accounting.md §7, D-22, D-23, Session 4). Pure, so every refusal is
// unit-tested; periods.ts re-checks them under the month's exclusive lock.
//   - December 2026 is the trial month: posted, never closed (also a CHECK in 0049);
//   - only a month that has ended can be closed (its last Jakarta day is before today);
//   - official months close in order: every earlier month since January 2027 must be closed
//     first, so "the first open month" a late correction lands in (D-23) is always the earliest
//     unfinished month, and a month's open posting issues include every older unposted event;
//   - and reopen in reverse order (the newest closed month first), so the closed months are always
//     an unbroken run from January 2027 (Session 4 review);
//   - the target date is the 10th of the next month (D-23). Missing it is shown, never blocks.

export const MAX_PERIOD_REASON_LENGTH = 500;

export const PERIOD_MESSAGES = {
  invalidMonth: "Bulan tidak valid.",
  trialMonth: "Desember 2026 adalah bulan uji coba dan tidak pernah ditutup.",
  beforeBooks: "Bulan ini sebelum pembukuan dimulai.",
  notEnded: "Bulan ini belum berakhir, jadi belum bisa ditutup.",
  earlierOpen: (monthLabel: string) => `Tutup ${monthLabel} dulu. Bulan ditutup berurutan.`,
  alreadyClosed: "Bulan ini sudah ditutup.",
  notClosed: "Bulan ini belum ditutup.",
  laterClosed: (monthLabel: string) => `Buka kembali ${monthLabel} dulu. Bulan dibuka kembali dari yang terbaru.`,
  overrideRequired: "Masih ada sumber yang belum bisa dibukukan di bulan ini. Selesaikan dulu, atau tulis alasan untuk tetap menutup.",
  overrideTooLong: `Alasan maksimal ${MAX_PERIOD_REASON_LENGTH} karakter.`,
  reopenReasonRequired: "Alasan membuka kembali wajib diisi.",
  reopenReasonTooLong: `Alasan maksimal ${MAX_PERIOD_REASON_LENGTH} karakter.`,
  postingStale: (count: number) => `Ada ${count} sumber yang belum dibukukan ulang sejak berubah. Jalankan Posting sekarang dulu, lalu tutup bulan.`,
  unbalanced: "Neraca saldo tidak seimbang. Bulan tidak bisa ditutup; hubungi tim aplikasi.",
} as const;

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** "2027-01-01" -> "Januari 2027". */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

export function isMonthStart(value: string): boolean {
  return isCalendarDate(value) && value.endsWith("-01");
}

/** D-23: the 10th of the next month. */
export function closeDeadlineOf(month: string): string {
  return `${nextMonthStart(month).slice(0, 8)}10`;
}

/** The months the Tutup buku page lists: the trial month through the current month, and at least
 * through January 2027 so the first official month is visible before the cut-over. */
export function periodMonthsToShow(today: string): string[] {
  const last = `${today.slice(0, 7)}-01` > OFFICIAL_BOOKS_START ? `${today.slice(0, 7)}-01` : OFFICIAL_BOOKS_START;
  const months: string[] = [];
  for (let month = TRIAL_BOOKS_START; month <= last; month = nextMonthStart(month)) months.push(month);
  return months;
}

/** Why `month` cannot be closed today, or null. `closedMonths` = first days of closed months. */
export function periodCloseRefusal(month: string, today: string, closedMonths: ReadonlySet<string>): string | null {
  if (!isMonthStart(month)) return PERIOD_MESSAGES.invalidMonth;
  if (month === TRIAL_BOOKS_START) return PERIOD_MESSAGES.trialMonth;
  if (month < OFFICIAL_BOOKS_START) return PERIOD_MESSAGES.beforeBooks;
  if (closedMonths.has(month)) return PERIOD_MESSAGES.alreadyClosed;
  if (monthEndOf(month) >= today) return PERIOD_MESSAGES.notEnded;
  for (let earlier = OFFICIAL_BOOKS_START; earlier < month; earlier = nextMonthStart(earlier)) {
    if (!closedMonths.has(earlier)) return PERIOD_MESSAGES.earlierOpen(monthLabel(earlier));
  }
  return null;
}

/** Why `month` cannot be reopened, or null: months reopen from the newest back, the mirror of
 * closing in order, so every closed month is always a run from January 2027 with no open gap. */
export function periodReopenRefusal(month: string, closedMonths: ReadonlySet<string>): string | null {
  if (!isMonthStart(month)) return PERIOD_MESSAGES.invalidMonth;
  if (!closedMonths.has(month)) return PERIOD_MESSAGES.notClosed;
  const later = [...closedMonths].filter((closed) => closed > month).sort();
  const latest = later[later.length - 1];
  return latest ? PERIOD_MESSAGES.laterClosed(monthLabel(latest)) : null;
}

/** An optional written reason (close override): trimmed, null when blank. */
export function normalizeOptionalReason(reason: string | null | undefined): string | null {
  const trimmed = (reason ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

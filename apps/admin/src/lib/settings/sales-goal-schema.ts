import { z } from "zod";
import { addCalendarYears, calendarDaysBetween, isCalendarDate } from "@ammari/commerce/jakarta-day";
import { parseRupiah } from "@/lib/products/money";

// "Target penjualan" on /settings (docs/plans/dashboard-overview.md §2.2, D2, D3). Pure, so the
// action and its tests share it; `today` is the Jakarta calendar date, passed in by the caller.

/** Rp 100 miliar. lib/overview/goal.ts multiplies the target by the days of the year (at most 366)
 * and the omzet by 10.000 (basis points); both stay far inside Number.MAX_SAFE_INTEGER (about
 * 9 x 10^15) with this cap, even when the omzet passes the target several times over. */
export const SALES_GOAL_MAX_AMOUNT = 100_000_000_000;

/** Earlier than this is a typo (e.g. "0202-11-01"), not a real Ammari year. */
export const SALES_GOAL_EARLIEST_START_DATE = "2020-01-01";

export const SALES_GOAL_MESSAGES = {
  amountFormat: "Isi target dengan angka rupiah, mis. 1.000.000.000.",
  amountRange: "Target harus antara Rp 1 dan Rp 100.000.000.000.",
  startDateFormat: "Pilih tanggal mulai yang valid.",
  startDateTooEarly: "Tanggal mulai paling awal 1 Jan 2020.",
  startDateTooLate: "Tanggal mulai paling lambat 1 tahun dari hari ini.",
  invalidInput: "Input tidak valid.",
} as const;

export function salesGoalSchema(today: string) {
  const latestStartDate = addCalendarYears(today, 1);
  return z.object({
    // A hand-made request can send a non-string; zod's own message would be English.
    revenueTarget: z.string({ error: SALES_GOAL_MESSAGES.invalidInput }).transform((value, ctx) => {
      const amount = parseRupiah(value);
      if (amount === null) {
        ctx.addIssue({ code: "custom", message: SALES_GOAL_MESSAGES.amountFormat });
        return z.NEVER;
      }
      if (amount < 1 || amount > SALES_GOAL_MAX_AMOUNT) {
        ctx.addIssue({ code: "custom", message: SALES_GOAL_MESSAGES.amountRange });
        return z.NEVER;
      }
      return amount;
    }),
    startDate: z.string({ error: SALES_GOAL_MESSAGES.invalidInput }).transform((value, ctx) => {
      if (!isCalendarDate(value)) {
        ctx.addIssue({ code: "custom", message: SALES_GOAL_MESSAGES.startDateFormat });
        return z.NEVER;
      }
      if (calendarDaysBetween(SALES_GOAL_EARLIEST_START_DATE, value) < 0) {
        ctx.addIssue({ code: "custom", message: SALES_GOAL_MESSAGES.startDateTooEarly });
        return z.NEVER;
      }
      if (calendarDaysBetween(value, latestStartDate) < 0) {
        ctx.addIssue({ code: "custom", message: SALES_GOAL_MESSAGES.startDateTooLate });
        return z.NEVER;
      }
      return value;
    }),
  });
}

export type SalesGoalFormInput = z.input<ReturnType<typeof salesGoalSchema>>;

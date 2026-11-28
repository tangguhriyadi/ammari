import type { ReconciliationStatus } from "./reconciliation-rules";

// Rekonsiliasi "TikTok Shop" (docs/plans/tiktok-shop-integration.md §5.4, T8): the pure half. Each check
// compares two figures; the status says whether the difference needs a look. Kept pure so every rule is
// unit-tested (tiktok-reconciliation-rules.test.ts).

/** (a) per order: the order's 1-1303 lines (M1 − M2 − S4/S7) against what TikTok settled for it. */
export interface TikTokOrderFigures {
  ledger: number;
  /** Σ settlement of the order's ORDER/REFUND statement transactions; null while none is settled. */
  settlement: number | null;
  /** The sale was recognised before this set of books (its M1 is in the opening balance). */
  startsBeforeBooks: boolean;
}

export interface TikTokOrderReconciliation extends TikTokOrderFigures {
  difference: number;
  /** ok: equal; explained: not settled yet (the balance waits for the statement); review: the sale is
   * before the books; mismatch: settled and different. */
  status: ReconciliationStatus;
}

export function reconcileTikTokOrder(figures: TikTokOrderFigures): TikTokOrderReconciliation {
  if (figures.settlement === null) return { ...figures, difference: 0, status: "explained" };
  const difference = figures.ledger - figures.settlement;
  const status: ReconciliationStatus = difference === 0 ? "ok" : figures.startsBeforeBooks ? "review" : "mismatch";
  return { ...figures, difference, status };
}

/** (b) per statement and (c) per payout: one total against the sum of its parts. Unreadable money is a
 * mismatch; parts not read yet are "review" (a total of 0 with no parts is simply equal). Never "equal"
 * on unknown figures. */
export function reconcileTotal(total: number | null, parts: number | null): { difference: number | null; status: ReconciliationStatus } {
  if (total === null) return { difference: null, status: "mismatch" };
  if (parts === null) return total === 0 ? { difference: 0, status: "ok" } : { difference: null, status: "review" };
  const difference = total - parts;
  return { difference, status: difference === 0 ? "ok" : "mismatch" };
}

/** (d) the whole 1-1303 balance against what TikTok still owes: estimates of unsettled orders plus
 * statements settled but not paid out. Timing (an order shipped but not in Get Unsettled yet, an
 * estimate that differs from its settlement) makes a difference normal, so it is "review", never a hard
 * mismatch. */
export function reconcileSellerBalance(ledger: number, unsettled: number, settledNotPaidOut: number): { expected: number; difference: number; status: ReconciliationStatus } {
  const expected = unsettled + settledNotPaidOut;
  const difference = ledger - expected;
  return { expected, difference, status: difference === 0 ? "ok" : "review" };
}

/** The M4/M5 ads pair list: an M5 ads line and an M4 expense (channel tiktok) of the same month and
 * amount are probably the same ad booked twice. Pairs by (month, amount), one to one. */
export interface AdsLine {
  id: string;
  month: string;
  amount: number;
  label: string;
}

export interface AdsPair {
  month: string;
  amount: number;
  adjustment: AdsLine;
  expense: AdsLine;
}

export function pairAdsLines(adjustments: readonly AdsLine[], expenses: readonly AdsLine[]): AdsPair[] {
  const pool = new Map<string, AdsLine[]>();
  for (const expense of [...expenses].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${expense.month}|${expense.amount}`;
    pool.set(key, [...(pool.get(key) ?? []), expense]);
  }
  const pairs: AdsPair[] = [];
  for (const adjustment of [...adjustments].sort((a, b) => a.month.localeCompare(b.month) || a.id.localeCompare(b.id))) {
    const candidates = pool.get(`${adjustment.month}|${adjustment.amount}`);
    const expense = candidates?.shift();
    if (expense) pairs.push({ month: adjustment.month, amount: adjustment.amount, adjustment, expense });
  }
  return pairs;
}

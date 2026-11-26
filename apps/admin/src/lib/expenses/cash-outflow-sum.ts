// The arithmetic of "Arus kas keluar" (docs/plans/expense-master-data.md §3.10), pure so it is
// unit-tested without a database. Whole rupiah, integers only.

export interface CashOutflowParts {
  /** Biaya operasional: business_expenses of kind operating. */
  operating: number;
  /** Pengeluaran produksi: supplier payments (purchases and production batches). */
  production: number;
  /** Iklan & endorse: business_expenses of kind ad and endorsement. */
  ads: number;
}

export interface CashOutflow extends CashOutflowParts {
  /** Total uang keluar. */
  total: number;
}

export function sumCashOutflow(parts: CashOutflowParts): CashOutflow {
  for (const [key, value] of Object.entries(parts)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${key} amount: ${value}`);
  }
  const total = parts.operating + parts.production + parts.ads;
  if (!Number.isSafeInteger(total)) throw new Error("cash outflow overflow");
  return { ...parts, total };
}

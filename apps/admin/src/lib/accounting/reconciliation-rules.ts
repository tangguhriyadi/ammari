// Rekonsiliasi checks 1 (persediaan) and 2 (utang) (docs/plans/accounting.md §6.3, Sessions 7 and 8). Pure: the
// SQL in ./reconciliation.ts gathers the figures, these functions decide what they mean, so every
// rule is unit-testable. Amounts are whole rupiah.

/** `review`: a difference on a document that started before the books did. Part of it is expected
 * (it lives in the opening balances, or nowhere in the trial month), but the check cannot tell how
 * much, so it is neither passed nor failed: the owner looks at it. */
export type ReconciliationStatus = "ok" | "explained" | "review" | "mismatch";

/** Check 1 for one raw-material account (1-1501 kain, 1-1502 aksesoris) as of a date. */
export interface MaterialFigures {
  /** Σ (debit − credit) on the account within the set of books, up to the date. */
  ledger: number;
  /** Stock-ledger values in the same window, by kind. */
  receipts: number;
  receiptReversals: number;
  adjustments: number;
  /** Consumption by production, dated by its batch's posting: journaled by R1 (Session 8). */
  production: number;
  /** Legacy single-row purchases and their voids: never journaled (posting issue / void rule). */
  legacy: number;
  /** Reversals of receipts dated before the books start: their originals were never journaled,
   * so neither are they (plan §2, void rule). */
  voidsBeforeBooks: number;
  /** Official books only: the stock value before the cut-over, which the opening journal carries. */
  beforeBooks: number;
}

export interface MaterialReconciliation extends MaterialFigures {
  /** What the stock ledger says the account should hold (all movements in the window). */
  stockValue: number;
  /** Stock-ledger movements the ledger does not carry on purpose (legacy, voids of receipts from
   * before the books). */
  notJournaled: number;
  /** ledger − (stockValue − notJournaled); 0 when the books follow the stock ledger. */
  difference: number;
  status: ReconciliationStatus;
}

export function reconcileMaterial(figures: MaterialFigures): MaterialReconciliation {
  const notJournaled = figures.legacy + figures.voidsBeforeBooks;
  const stockValue = figures.beforeBooks + figures.receipts + figures.receiptReversals + figures.adjustments + figures.production + notJournaled;
  const difference = figures.ledger - (stockValue - notJournaled);
  const status: ReconciliationStatus = difference !== 0 ? "mismatch" : notJournaled !== 0 ? "explained" : "ok";
  return { ...figures, stockValue, notJournaled, difference, status };
}

/** Check 1 for any inventory account (Session 8: 1-1503, 1-1504, 1-1506): the ledger against the
 * value the source records give it, less the parts the ledger does not carry on purpose. */
export interface StockAccountFigures {
  ledger: number;
  /** What the source records say the account holds in the window (opening part included). */
  stockValue: number;
  /** Parts of stockValue no journal carries on purpose, each with its reason (labels are UI text). */
  notJournaled: { label: string; value: number }[];
}

export interface StockAccountReconciliation extends StockAccountFigures {
  notJournaledTotal: number;
  /** ledger − (stockValue − notJournaledTotal). */
  difference: number;
  status: ReconciliationStatus;
}

export function reconcileStockAccount(figures: StockAccountFigures): StockAccountReconciliation {
  const notJournaled = figures.notJournaled.filter((part) => part.value !== 0);
  const notJournaledTotal = notJournaled.reduce((sum, part) => sum + part.value, 0);
  const difference = figures.ledger - (figures.stockValue - notJournaledTotal);
  const status: ReconciliationStatus = difference !== 0 ? "mismatch" : notJournaledTotal !== 0 ? "explained" : "ok";
  return { ...figures, notJournaled, notJournaledTotal, difference, status };
}

/** Check 1 for one production batch's work in progress (1-1503). */
export interface WipBatchFigures {
  /** The batch's WIP from its own records as of the date: cost − received − rejected + returned to
   * the tailor; 0 once production ended (R3 settled the rest). */
  appWip: number;
  /** The same as of the day before the set of books starts, for a batch posted before it: that part
   * lives in the opening journal (official books) or nowhere (the trial month), not in the batch's
   * own journals. 0 otherwise. */
  beforeBooks: number;
  /** Σ 1-1503 lines of this batch's journals within the set of books up to the date. */
  ledger: number;
  startsBeforeBooks: boolean;
  /** A receipt value is unknown (a posting issue): the app side cannot be computed. */
  valueMissing: boolean;
}

export interface WipBatchReconciliation extends WipBatchFigures {
  /** ledger − (appWip − beforeBooks). */
  difference: number;
  status: ReconciliationStatus;
}

export function reconcileWipBatch(figures: WipBatchFigures): WipBatchReconciliation {
  const difference = figures.ledger - (figures.appWip - figures.beforeBooks);
  let status: ReconciliationStatus;
  if (figures.valueMissing) status = "mismatch";
  else if (difference === 0) status = figures.beforeBooks !== 0 ? "explained" : "ok";
  else status = figures.startsBeforeBooks ? "review" : "mismatch";
  return { ...figures, difference, status };
}

/** Check 2 for one purchase document. */
export interface PayableFigures {
  /** The app's tagihan (purchase-payments §3.1) and the non-voided payments up to the date. */
  tagihan: number;
  paid: number;
  /** This document's journals within the set of books up to the date. */
  ledgerPayable: number;
  ledgerAdvance: number;
  ledgerClaim: number;
  /** Σ receipt values (accepted + rejected) minus returns to the supplier, from the source records. */
  netReceived: number;
  /** Some event of the document is dated before the set of books starts: that part lives in the
   * opening balances (official books) or nowhere (the trial month), not in this document's
   * journals, so a difference is expected. */
  startsBeforeBooks: boolean;
}

export interface PayableReconciliation extends PayableFigures {
  /** tagihan − paid: what the app shows as still owed (negative = lebih bayar). */
  appBalance: number;
  /** utang − uang muka − piutang klaim, from the ledger. */
  ledgerBalance: number;
  /** tagihan − net received: ordered and not (or no longer) received. The app counts it as owed,
   * the ledger does not (utang starts at receipt, D-13). */
  notReceived: number;
  /** appBalance − (ledgerBalance + notReceived). */
  difference: number;
  status: ReconciliationStatus;
}

export function reconcilePayable(figures: PayableFigures): PayableReconciliation {
  const appBalance = figures.tagihan - figures.paid;
  const ledgerBalance = figures.ledgerPayable - figures.ledgerAdvance - figures.ledgerClaim;
  const notReceived = figures.tagihan - figures.netReceived;
  const difference = appBalance - (ledgerBalance + notReceived);
  let status: ReconciliationStatus;
  if (difference === 0) status = notReceived !== 0 ? "explained" : "ok";
  else status = figures.startsBeforeBooks ? "review" : "mismatch";
  return { ...figures, appBalance, ledgerBalance, notReceived, difference, status };
}

export const RECONCILIATION_STATUS_LABELS: Record<ReconciliationStatus, string> = {
  ok: "Cocok",
  explained: "Cocok, ada selisih yang dijelaskan",
  review: "Perlu diperiksa (sebagian sebelum pembukuan)",
  mismatch: "Tidak cocok",
};

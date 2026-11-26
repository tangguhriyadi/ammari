import type { PurchaseItemType, PurchaseStatus, SupplierPaymentMethod } from "@ammari/db/schema";
import { jakartaDateOf } from "../dates";
import type { JournalLineDraft } from "../journal";
import {
  mappedAccount,
  resolveOrIssue,
  systemAccount,
  type PostingContext,
  type PostingEvent,
  type PostingKey,
  type PostingOutcome,
  type PostingRule,
} from "./types";
import { SUPPLIER_PAYMENT_SOURCE_TYPE } from "./supplier-payments";

// The purchase document chain (docs/plans/accounting.md §4.4, Session 7). Utang is recognised at
// goods receipt, not at order [D-13]. All events of ONE purchase document are replayed in date order
// (ties by the record's own timestamp; a negation never before its original), so every journal is
// deterministic and re-derived whenever an earlier event appears or changes.
//
// Position rule (owner, 26 Nov 2026): the document's net position is
//   N = receipt value (accepted + rejected) − returns to the supplier − payments.
// After every event the document's balance sits on exactly one account, never on a wrong side:
//   N > 0            → 2-1101 Utang usaha pemasok bahan = N
//   N < 0, open      → 1-1601 Uang muka pembelian       = −N
//   N < 0, closed    → 1-1402 Piutang klaim pemasok     = −N   (closed or cancelled)
// Each event's journal = its own side (stock, cash or defects) + only the CHANGE of those three
// balances that the event causes. So a DP builds 1-1601, a receipt uses it first and the rest is
// utang; a void of a DP that a receipt already used turns that part into utang; reversing a paid
// receipt turns the payment into an advance; a return on paid goods is an advance the replacement
// receipt then uses.
//
//   P1 (goods_receipt_item, id, received), dated received_at: Dr 1-1501 kain / 1-1502 aksesoris
//        (raw-ledger value of the accepted part), Dr 1-1506 cacat (reject value) + position change.
//   P2 (goods_receipt_item, <reversal item id>, reversed), dated the reversal's received_at: the
//        reversed item's stock lines negated + position change.
//   P3 (supplier_payment, id, paid), dated paid_at: Cr Kas/Bank (cash.method.<method>, D-17)
//        + position change.
//   P4 (supplier_payment, id, void), dated voided_at: Dr Kas/Bank + position change.
//   P5 (purchase, id, closed_overpaid), dated closed_at, while closed/cancelled: the advance left
//        moves to 1-1402 (Dr 1-1402 / Cr 1-1601). A reopen un-posts it (reversal), and every later
//        event is re-derived on the open side; the next close posts it again.
//   P6 (defect_movement, id, return_out), purchase line, dated occurred_at: Cr 1-1506 the return's
//        value + position change (a debit note on utang; on goods already paid, an advance).
//        Its reversal (defect_movement, <reversal row id>, return_out) mirrors it.
// When nothing went wrong (no wrong-side balance to avoid) P2, P4 and P6's reversal come out as the
// exact negation of their original.
//
// Every line is on inventory, advance, claim, utang or cash/bank: never an expense (D-14 guard,
// PURCHASE_SIDE_JOURNAL_SOURCES; test/purchase-chain.test.ts checks it for every path).
//
// Cut-over (plan §2): an event dated before the posting start is not posted (its effect lives in
// the opening balances) but is still replayed, so a later payment clears the utang an earlier
// receipt built. A negation (P2, P4, P6's reversal) is posted only while its original has an
// active journal in the same set of books (`requiresActiveJournalFor`, the runner checks).

export const GOODS_RECEIPT_ITEM_SOURCE_TYPE = "goods_receipt_item";
export const PURCHASE_SOURCE_TYPE = "purchase";
export const DEFECT_MOVEMENT_SOURCE_TYPE = "defect_movement";

export interface PurchaseReceiptItemSnapshot {
  id: string;
  receiptNo: string;
  kind: "receipt" | "reversal";
  /** Jakarta day the goods arrived (for a reversal, the day it was recorded). */
  receivedAt: string;
  /** The receipt header's created_at (the tie-break within one day). */
  createdAt: Date;
  /** For a reversal item: the receipt item it negates (same purchase line, reversed receipt). */
  reversesItemId: string | null;
  itemType: PurchaseItemType;
  itemName: string;
  qtyAccepted: number;
  qtyRejected: number;
  /** Σ value_amount of the raw-ledger rows this item wrote (fabric/accessory, ref_type
   * goods_receipt); null when none exists. */
  acceptedValue: number | null;
  /** Σ value_amount of the defect rows naming this item (the reject or its reversal); null when
   * none exists. */
  rejectValue: number | null;
}

export interface PurchasePaymentSnapshot {
  id: string;
  paymentNo: string;
  paidAt: string;
  createdAt: Date;
  amount: number;
  method: SupplierPaymentMethod;
  voidedAt: Date | null;
}

export interface PurchaseDefectReturnSnapshot {
  id: string;
  type: "return_out" | "reversal";
  /** For a reversal: the return_out row it negates. */
  reversesMovementId: string | null;
  occurredAt: string;
  createdAt: Date;
  /** Signed: negative for a return_out, positive for its reversal. */
  valueAmount: number;
  itemName: string;
}

export interface PurchaseDocumentSnapshot {
  id: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseStatus;
  /** The latest close stamp (kept after a reopen; only read while status is closed/cancelled). */
  closedAt: Date | null;
  receiptItems: PurchaseReceiptItemSnapshot[];
  payments: PurchasePaymentSnapshot[];
  defectReturns: PurchaseDefectReturnSnapshot[];
}

/** The document's balances on the three position accounts; at most one is non-zero. */
export interface ChainState {
  /** N: receipts − returns − payments. */
  net: number;
  closed: boolean;
  payable: number;
  advance: number;
  claim: number;
}

/** What one step changed on the position accounts (debit-positive for advance and claim, credit-
 * positive for payable, i.e. each in its account's normal direction). */
export interface PositionDelta {
  payable: number;
  advance: number;
  claim: number;
}

type Step =
  | { kind: "receipt"; date: string; ts: number; id: string; item: PurchaseReceiptItemSnapshot }
  | { kind: "receipt_reversal"; date: string; ts: number; id: string; item: PurchaseReceiptItemSnapshot }
  | { kind: "payment"; date: string; ts: number; id: string; payment: PurchasePaymentSnapshot }
  | { kind: "payment_void"; date: string; ts: number; id: string; payment: PurchasePaymentSnapshot }
  | { kind: "return"; date: string; ts: number; id: string; movement: PurchaseDefectReturnSnapshot }
  | { kind: "return_reversal"; date: string; ts: number; id: string; movement: PurchaseDefectReturnSnapshot }
  | { kind: "close"; date: string; ts: number; id: string };

/** Breaks exact (date, timestamp) ties only. */
const STEP_RANK: Record<Step["kind"], number> = {
  receipt: 0,
  return: 1,
  payment: 2,
  receipt_reversal: 3,
  return_reversal: 4,
  payment_void: 5,
  close: 6,
};

export function stepKey(kind: Step["kind"], id: string): string {
  return `${kind}:${id}`;
}

function compareSteps(a: Step, b: Step): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (STEP_RANK[a.kind] !== STEP_RANK[b.kind]) return STEP_RANK[a.kind] - STEP_RANK[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const laterDate = (a: string, b: string) => (a > b ? a : b);

export function isTerminalPurchaseStatus(status: PurchaseStatus): boolean {
  return status === "closed" || status === "cancelled";
}

/** The chain's ordered steps. A negation is never ordered before its original (a backdated
 * original recorded after its reversal still replays first). */
function chainSteps(document: PurchaseDocumentSnapshot): Step[] {
  const steps: Step[] = [];
  const itemById = new Map(document.receiptItems.map((item) => [item.id, item]));
  for (const item of document.receiptItems) {
    if (item.kind === "receipt") {
      steps.push({ kind: "receipt", date: item.receivedAt, ts: item.createdAt.getTime(), id: item.id, item });
    } else {
      const original = item.reversesItemId ? itemById.get(item.reversesItemId) : undefined;
      const date = original ? laterDate(item.receivedAt, original.receivedAt) : item.receivedAt;
      const ts = original ? Math.max(item.createdAt.getTime(), original.createdAt.getTime()) : item.createdAt.getTime();
      steps.push({ kind: "receipt_reversal", date, ts, id: item.id, item });
    }
  }
  for (const payment of document.payments) {
    steps.push({ kind: "payment", date: payment.paidAt, ts: payment.createdAt.getTime(), id: payment.id, payment });
    if (payment.voidedAt) {
      const ts = Math.max(payment.voidedAt.getTime(), payment.createdAt.getTime());
      steps.push({ kind: "payment_void", date: laterDate(jakartaDateOf(payment.voidedAt), payment.paidAt), ts, id: payment.id, payment });
    }
  }
  const movementById = new Map(document.defectReturns.map((movement) => [movement.id, movement]));
  for (const movement of document.defectReturns) {
    if (movement.type === "return_out") {
      steps.push({ kind: "return", date: movement.occurredAt, ts: movement.createdAt.getTime(), id: movement.id, movement });
    } else {
      const original = movement.reversesMovementId ? movementById.get(movement.reversesMovementId) : undefined;
      const date = original ? laterDate(movement.occurredAt, original.occurredAt) : movement.occurredAt;
      const ts = original ? Math.max(movement.createdAt.getTime(), original.createdAt.getTime()) : movement.createdAt.getTime();
      steps.push({ kind: "return_reversal", date, ts, id: movement.id, movement });
    }
  }
  if (isTerminalPurchaseStatus(document.status) && document.closedAt) {
    steps.push({ kind: "close", date: jakartaDateOf(document.closedAt), ts: document.closedAt.getTime(), id: document.id });
  }
  return steps.sort(compareSteps);
}

/** A receipt item's stock values (accepted, rejected), or why they cannot be known. */
function receiptValue(item: PurchaseReceiptItemSnapshot): { inventory: number; reject: number } | { issueCode: string; details: Record<string, unknown> } {
  if (item.qtyAccepted !== 0 && item.acceptedValue === null) {
    return { issueCode: "receipt_value_missing", details: { goodsReceiptItemId: item.id, receiptNo: item.receiptNo, part: "accepted" } };
  }
  if (item.qtyRejected !== 0 && item.rejectValue === null) {
    return { issueCode: "receipt_value_missing", details: { goodsReceiptItemId: item.id, receiptNo: item.receiptNo, part: "rejected" } };
  }
  const inventory = item.acceptedValue ?? 0;
  const reject = item.rejectValue ?? 0;
  if (inventory < 0 || reject < 0) {
    return { issueCode: "receipt_value_invalid", details: { goodsReceiptItemId: item.id, receiptNo: item.receiptNo, inventory, reject } };
  }
  return { inventory, reject };
}

/** The balances a net position must sit on (the position rule above). */
export function positionFor(net: number, closed: boolean): PositionDelta {
  if (net >= 0) return { payable: net, advance: 0, claim: 0 };
  return closed ? { payable: 0, advance: 0, claim: -net } : { payable: 0, advance: -net, claim: 0 };
}

/** One replayed step: its own stock/cash side and the position change it caused. */
export interface StepResult {
  /** Stock values moved (positive = into stock), for receipts, their reversals, returns. */
  inventory: number;
  reject: number;
  /** Cash moved (positive = paid out), for payments and their voids. */
  cash: number;
  delta: PositionDelta;
}

/** The pure replay (exported for tests and the reconciliation): every step's result by
 * `stepKey(kind, id)`, and the document's state after the last step. `blocked` names the first
 * step the chain stopped at; every later step is in `blockedStepKeys`. */
export interface ChainResult {
  steps: Map<string, StepResult>;
  state: ChainState;
  blocked: { stepKey: string; issueCode: string; details: Record<string, unknown> } | null;
  blockedStepKeys: Set<string>;
}

export function replayPurchaseChain(document: PurchaseDocumentSnapshot): ChainResult {
  const result: ChainResult = {
    steps: new Map(),
    state: { net: 0, closed: false, payable: 0, advance: 0, claim: 0 },
    blocked: null,
    blockedStepKeys: new Set(),
  };
  const state = result.state;
  const itemById = new Map(document.receiptItems.map((item) => [item.id, item]));
  const movementById = new Map(document.defectReturns.map((movement) => [movement.id, movement]));

  /** Applies a change of N (and/or of closed), recording the position change. */
  const move = (key: string, own: Omit<StepResult, "delta">, netChange: number, closed = state.closed) => {
    state.net += netChange;
    state.closed = closed;
    const next = positionFor(state.net, state.closed);
    const delta = { payable: next.payable - state.payable, advance: next.advance - state.advance, claim: next.claim - state.claim };
    Object.assign(state, next);
    result.steps.set(key, { ...own, delta });
  };
  const block = (key: string, issueCode: string, details: Record<string, unknown>) => {
    result.blocked = { stepKey: key, issueCode, details };
    result.blockedStepKeys.add(key);
  };

  for (const step of chainSteps(document)) {
    const key = stepKey(step.kind, step.id);
    if (result.blocked) {
      result.blockedStepKeys.add(key);
      continue;
    }
    switch (step.kind) {
      case "receipt": {
        const value = receiptValue(step.item);
        if ("issueCode" in value) {
          block(key, value.issueCode, value.details);
          break;
        }
        move(key, { ...value, cash: 0 }, value.inventory + value.reject);
        break;
      }
      case "receipt_reversal": {
        const original = step.item.reversesItemId ? itemById.get(step.item.reversesItemId) : undefined;
        const originalValue = original && original.kind === "receipt" ? receiptValue(original) : undefined;
        if (!originalValue || "issueCode" in originalValue) {
          block(key, "receipt_reversal_unmatched", { goodsReceiptItemId: step.item.id, receiptNo: step.item.receiptNo, reversesItemId: step.item.reversesItemId });
          break;
        }
        move(key, { inventory: -originalValue.inventory, reject: -originalValue.reject, cash: 0 }, -(originalValue.inventory + originalValue.reject));
        break;
      }
      case "payment":
        move(key, { inventory: 0, reject: 0, cash: step.payment.amount }, -step.payment.amount);
        break;
      case "payment_void":
        move(key, { inventory: 0, reject: 0, cash: -step.payment.amount }, step.payment.amount);
        break;
      case "return": {
        const value = -step.movement.valueAmount;
        move(key, { inventory: 0, reject: -value, cash: 0 }, -value);
        break;
      }
      case "return_reversal": {
        const original = step.movement.reversesMovementId ? movementById.get(step.movement.reversesMovementId) : undefined;
        if (!original || original.type !== "return_out") {
          block(key, "return_reversal_unmatched", { defectMovementId: step.movement.id });
          break;
        }
        const value = -original.valueAmount;
        move(key, { inventory: 0, reject: value, cash: 0 }, value);
        break;
      }
      case "close":
        move(key, { inventory: 0, reject: 0, cash: 0 }, 0, true);
        break;
    }
  }
  return result;
}

interface ChainAccounts {
  fabric: string;
  accessory: string;
  defect: string;
  advance: string;
  claim: string;
  payable: string;
}

function chainAccounts(context: PostingContext): ChainAccounts {
  return {
    fabric: systemAccount(context, "inventory.fabric"),
    accessory: systemAccount(context, "inventory.accessory"),
    defect: systemAccount(context, "inventory.defect"),
    advance: systemAccount(context, "prepaid.purchase_advance"),
    claim: systemAccount(context, "receivable.supplier_claim"),
    payable: mappedAccount(context, "supplier_payable.kind.material", "unmapped_supplier_payable", { targetType: "purchase" }),
  };
}

/** A signed amount as one line: positive = debit, negative = credit, zero = no line. */
function signedLine(accountCode: string, debitPositive: number, extra: Partial<JournalLineDraft>): JournalLineDraft[] {
  if (debitPositive === 0) return [];
  return [{ accountCode, debit: Math.max(debitPositive, 0), credit: Math.max(-debitPositive, 0), ...extra }];
}

const ACCEPTED_ACCOUNT: Record<PurchaseItemType, "fabric" | "accessory"> = { fabric: "fabric", accessory: "accessory" };

/** A step's journal: its own side, then the position change (utang, uang muka, piutang klaim). */
function stepOutcome(
  document: PurchaseDocumentSnapshot,
  result: StepResult,
  description: string,
  context: PostingContext,
  own: { itemType?: PurchaseItemType; itemName?: string; cashMethod?: SupplierPaymentMethod },
): PostingOutcome {
  return resolveOrIssue(() => {
    const accounts = chainAccounts(context);
    const cash = own.cashMethod ? mappedAccount(context, `cash.method.${own.cashMethod}`, "unmapped_payment_method", { method: own.cashMethod }) : null;
    const dims = { supplierId: document.supplierId, ...(cash ? { cashAccountCode: cash } : {}) };
    const memo = own.itemName ?? null;
    const lines = [
      ...(own.itemType ? signedLine(accounts[ACCEPTED_ACCOUNT[own.itemType]], result.inventory, { ...dims, memo }) : []),
      ...signedLine(accounts.defect, result.reject, { ...dims, memo: memo ? `${memo} (cacat)` : null }),
      ...(cash ? signedLine(cash, -result.cash, dims) : []),
      ...signedLine(accounts.payable, -result.delta.payable, dims),
      ...signedLine(accounts.advance, result.delta.advance, dims),
      ...signedLine(accounts.claim, result.delta.claim, dims),
    ];
    // Debits first, then credits, each in the order above.
    const ordered = [...lines.filter((line) => line.debit > 0), ...lines.filter((line) => line.credit > 0)];
    return ordered.length === 0 ? { kind: "none" } : { kind: "journal", description, lines: ordered };
  });
}

function blockedIssue(chain: ChainResult): PostingOutcome {
  const blocked = chain.blocked;
  // Never throws: an unexpected unblocked call is still an issue for this key, not a failed run.
  if (!blocked) return { kind: "issue", issueCode: "purchase_chain_inconsistent", details: {} };
  return { kind: "issue", issueCode: blocked.issueCode, details: { ...blocked.details, blockedStep: blocked.stepKey } };
}

export const PURCHASE_CHAIN_RULE_VERSION = 2;

function keys(document: PurchaseDocumentSnapshot) {
  return {
    receipt: (id: string): PostingKey => ({ sourceType: GOODS_RECEIPT_ITEM_SOURCE_TYPE, sourceId: id, sourceEvent: "received" }),
    receiptReversal: (id: string): PostingKey => ({ sourceType: GOODS_RECEIPT_ITEM_SOURCE_TYPE, sourceId: id, sourceEvent: "reversed" }),
    payment: (id: string): PostingKey => ({ sourceType: SUPPLIER_PAYMENT_SOURCE_TYPE, sourceId: id, sourceEvent: "paid" }),
    paymentVoid: (id: string): PostingKey => ({ sourceType: SUPPLIER_PAYMENT_SOURCE_TYPE, sourceId: id, sourceEvent: "void" }),
    returnOut: (id: string): PostingKey => ({ sourceType: DEFECT_MOVEMENT_SOURCE_TYPE, sourceId: id, sourceEvent: "return_out" }),
    close: (): PostingKey => ({ sourceType: PURCHASE_SOURCE_TYPE, sourceId: document.id, sourceEvent: "closed_overpaid" }),
  };
}

/** Every posting event of one purchase document: originals in chain order, then their negations
 * (so an original posted in this run is active before its negation is checked), then P5. */
export function purchaseChainEvents(document: PurchaseDocumentSnapshot, context: PostingContext): PostingEvent[] {
  const chain = replayPurchaseChain(document);
  const key = keys(document);
  const beforeStart = (date: string) => date < context.postingStartDate;
  const originals: PostingEvent[] = [];
  const negations: PostingEvent[] = [];
  const supplier = document.supplierName;

  /** The step's journal, or the chain's issue when the step was never replayed. */
  const outcomeOf = (kind: Step["kind"], id: string, description: string, own: Parameters<typeof stepOutcome>[4]): PostingOutcome => {
    const stepResult = chain.steps.get(stepKey(kind, id));
    if (chain.blockedStepKeys.has(stepKey(kind, id)) || !stepResult) return blockedIssue(chain);
    return stepOutcome(document, stepResult, description, context, own);
  };

  const itemById = new Map(document.receiptItems.map((item) => [item.id, item]));
  for (const item of document.receiptItems) {
    const own = { itemType: item.itemType, itemName: item.itemName };
    if (item.kind === "receipt") {
      const outcome: PostingOutcome = beforeStart(item.receivedAt)
        ? { kind: "none" }
        : outcomeOf("receipt", item.id, `Penerimaan ${item.receiptNo} pembelian ${document.purchaseNo} dari ${supplier}: ${item.itemName}`, own);
      originals.push({ key: key.receipt(item.id), sourceDate: item.receivedAt, outcome });
      continue;
    }
    const original = item.reversesItemId ? itemById.get(item.reversesItemId) : undefined;
    const description = `Pembatalan penerimaan ${original?.receiptNo ?? ""} (${item.receiptNo}) pembelian ${document.purchaseNo}: ${item.itemName}`;
    negations.push({
      key: key.receiptReversal(item.id),
      sourceDate: item.receivedAt,
      outcome: outcomeOf("receipt_reversal", item.id, description, own),
      ...(item.reversesItemId ? { requiresActiveJournalFor: key.receipt(item.reversesItemId) } : {}),
    });
  }

  for (const payment of document.payments) {
    const own = { cashMethod: payment.method };
    originals.push({
      key: key.payment(payment.id),
      sourceDate: payment.paidAt,
      outcome: beforeStart(payment.paidAt) ? { kind: "none" } : outcomeOf("payment", payment.id, `Pembayaran pembelian ${document.purchaseNo} ke ${supplier} (${payment.paymentNo})`, own),
    });
    if (payment.voidedAt) {
      negations.push({
        key: key.paymentVoid(payment.id),
        sourceDate: jakartaDateOf(payment.voidedAt),
        outcome: outcomeOf("payment_void", payment.id, `Pembatalan pembayaran ${payment.paymentNo}`, own),
        requiresActiveJournalFor: key.payment(payment.id),
      });
    }
  }

  for (const movement of document.defectReturns) {
    const own = { itemName: movement.itemName };
    if (movement.type === "return_out") {
      const outcome: PostingOutcome = beforeStart(movement.occurredAt)
        ? { kind: "none" }
        : outcomeOf("return", movement.id, `Retur barang cacat ke ${supplier}, pembelian ${document.purchaseNo}: ${movement.itemName}`, own);
      originals.push({ key: key.returnOut(movement.id), sourceDate: movement.occurredAt, outcome });
      continue;
    }
    if (!movement.reversesMovementId) continue; // not a return's reversal (the loader passes only those)
    negations.push({
      key: key.returnOut(movement.id),
      sourceDate: movement.occurredAt,
      outcome: outcomeOf("return_reversal", movement.id, `Pembatalan retur barang cacat ke ${supplier}, pembelian ${document.purchaseNo}: ${movement.itemName}`, own),
      requiresActiveJournalFor: key.returnOut(movement.reversesMovementId),
    });
  }

  const events = [...originals, ...negations];
  // P5 only for a document that was ever closed: a reopened one emits "none", which reverses an
  // active P5 (and is a no-op otherwise).
  if (document.closedAt) {
    const closeDate = jakartaDateOf(document.closedAt);
    const outcome: PostingOutcome =
      isTerminalPurchaseStatus(document.status) && !beforeStart(closeDate)
        ? outcomeOf("close", document.id, `Lebih bayar pembelian ${document.purchaseNo} ke ${supplier} saat ditutup`, {})
        : { kind: "none" };
    events.push({ key: key.close(), sourceDate: closeDate, outcome });
  }
  return events;
}

export const purchaseChainRule: PostingRule<PurchaseDocumentSnapshot> = {
  name: "purchase_chain",
  // 2: supersedes the Session 2 purchase-payment journals (rule supplier_payment v1, "without
  // chain"), so every P3/P4 is re-derived on the position rule (reverse + repost; a closed month's
  // difference lands in the first open month, D-23).
  ruleVersion: PURCHASE_CHAIN_RULE_VERSION,
  events: purchaseChainEvents,
};

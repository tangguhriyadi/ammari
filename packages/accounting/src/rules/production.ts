import type { ProductionBatchStatus, ProductionReceiptStatus, SupplierPaymentMethod } from "@ammari/db/schema";
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
import { DEFECT_MOVEMENT_SOURCE_TYPE, GOODS_RECEIPT_ITEM_SOURCE_TYPE } from "./purchases";
import { SUPPLIER_PAYMENT_SOURCE_TYPE } from "./supplier-payments";

// Production (docs/plans/accounting.md §4.5, Session 8). One production batch is one document; its
// events are posted from the records the app already writes (postBatch, production goods receipts,
// batch payments, defect returns to the tailor). Nothing here writes a source record.
//
//   R1 (production_batch, id, posted), dated posted_at (Jakarta): Dr 1-1503 Barang dalam proses =
//        fabric consumed + accessories consumed + Σ cost lines / Cr 1-1501 kain (the batch's
//        fabric 'production' movements) · Cr 1-1502 aksesoris (its accessory 'production'
//        movements) · the service cost lines as a position change per payee (below). Fabric and
//        accessories stay inventory until consumed here (D-14).
//   R2 (goods_receipt_item, id, received), production receipt, dated received_at: Dr 1-1504 barang
//        jadi (the item's stock_movements value) · Dr 1-1506 cacat (its reject value) / Cr 1-1503.
//        Its reversal (goods_receipt_item, <reversal item id>, reversed) books the reversal item's
//        own (negated) values, posted only while the original has an active journal.
//   R3 (production_batch, id, wip_close), automatic [D-15], when the batch's receipt_status is
//        `received` or `closed`, dated the later of the close and the batch's last receipt/return:
//        the batch's remaining 1-1503 balance. `received` (finished normally: the ceil-rounding
//        residue) → 5-1201 Selisih biaya produksi (HPP), either sign. `closed` (short-closed early,
//        e.g. Haura beige L, 12 planned, 6 made) → 6-4102 Kerusakan & kehilangan persediaan
//        (operating expense, D-16), either sign. A reopen un-posts R3 (the runner reverses it); the
//        next close posts it again.
//   R4 (supplier_payment, id, paid), batch payment, dated paid_at: Cr Kas/Bank (cash.method.<method>)
//        + the position change; its void (supplier_payment, id, void) Dr Kas/Bank + the change.
//   R5 (defect_movement, id, return_out), defect returned to the tailor, dated occurred_at: Dr 1-1503
//        / Cr 1-1506 (back into process; the replacement receipt, R2, takes it out again). Its
//        reversal (defect_movement, <reversal row id>, return_out) mirrors it.
//
// Position rule for the service bill (the Session 7 rule, per payee of the batch): N = the payee's
// cost lines (from R1 on) − the payee's payments. After every step:
//   N > 0                   → 2-1102 Utang usaha jasa produksi (2-1103 when the lines have no payee)
//   N < 0, batch running    → 1-1601 Uang muka pembelian (paid before the batch was posted)
//   N < 0, production ended → 1-1402 Piutang klaim pemasok (ended = R3's step: received or closed)
// Each R1/R3/R4 journal holds only the change of those balances its step causes, so neither utang
// nor uang muka nor piutang klaim ever ends on the wrong side for a payee. Without a wrong side at
// stake a void comes out as the exact negation of its payment.
//
// Every R1, R2, R4 and R5 line is on inventory, advance, claim, utang or cash/bank (D-14 guard,
// PURCHASE_SIDE_JOURNAL_SOURCES). R3 is the one production journal that posts to 5-1201/6-4102, by
// decided policy (D-15), and is not a guarded source.
//
// Cut-over (plan §2): a step dated before the posting start is replayed (so a December payment clears
// a November batch's utang, and R3 settles the whole batch) but not posted. A negation (R2's reversal,
// R4's void, R5's reversal) is posted only while its original has an active journal in the same set
// of books (`requiresActiveJournalFor`, the runner checks).

export const PRODUCTION_BATCH_SOURCE_TYPE = "production_batch";

export interface ProductionReceiptItemSnapshot {
  id: string;
  receiptNo: string;
  kind: "receipt" | "reversal";
  /** Jakarta day the goods arrived (for a reversal, the reversal's own received_at). */
  receivedAt: string;
  createdAt: Date;
  /** For a reversal item: the receipt item it negates. */
  reversesItemId: string | null;
  sku: string;
  qtyAccepted: number;
  qtyRejected: number;
  /** Σ stock_movements value (type production, ref goods_receipt_item = this item); null = none. */
  acceptedValue: number | null;
  /** Σ defect_movements value naming this item (the reject or its reversal); null = none. */
  rejectValue: number | null;
}

export interface ProductionPaymentSnapshot {
  id: string;
  paymentNo: string;
  supplierId: string | null;
  supplierName: string | null;
  paidAt: string;
  createdAt: Date;
  amount: number;
  method: SupplierPaymentMethod;
  voidedAt: Date | null;
}

export interface ProductionDefectReturnSnapshot {
  id: string;
  type: "return_out" | "reversal";
  reversesMovementId: string | null;
  occurredAt: string;
  createdAt: Date;
  /** Signed: negative for a return_out, positive for its reversal. */
  valueAmount: number;
  sku: string;
}

export interface ProductionCostLineSnapshot {
  supplierId: string | null;
  supplierName: string | null;
  total: number;
}

export interface ProductionBatchSnapshot {
  id: string;
  batchNo: string;
  status: ProductionBatchStatus;
  postedAt: Date | null;
  receiptStatus: ProductionReceiptStatus;
  /** The latest short-close stamp (kept after a reopen). */
  closedAt: Date | null;
  /** Σ −value of the batch's fabric 'production' movements (>= 0); null when it has none. */
  fabricConsumed: number | null;
  /** Σ −value of the batch's accessory 'production' movements (>= 0; 0 when none). */
  accessoryConsumed: number;
  costLines: ProductionCostLineSnapshot[];
  /** Stock added at posting by a release before goods receipts (migration 0025): such a batch's
   * output never went through R2, so R3 cannot know its rest. */
  hasLegacyStock: boolean;
  receiptItems: ProductionReceiptItemSnapshot[];
  payments: ProductionPaymentSnapshot[];
  defectReturns: ProductionDefectReturnSnapshot[];
}

/** The payee's key: the supplier, or "" for the lines nobody attributed. */
const payeeKey = (supplierId: string | null) => supplierId ?? "";

export function isEndedReceiptStatus(status: ProductionReceiptStatus): boolean {
  return status === "received" || status === "closed";
}

const laterDate = (a: string, b: string) => (a > b ? a : b);

/** The batch's cost moved into WIP at R1, or why it cannot be known. */
export function batchCost(batch: ProductionBatchSnapshot): { fabric: number; accessory: number; services: number; total: number } | { issueCode: string; details: Record<string, unknown> } {
  if (batch.fabricConsumed === null) return { issueCode: "batch_consumption_missing", details: { batchNo: batch.batchNo } };
  const services = batch.costLines.reduce((sum, line) => sum + line.total, 0);
  return { fabric: batch.fabricConsumed, accessory: batch.accessoryConsumed, services, total: batch.fabricConsumed + batch.accessoryConsumed + services };
}

/** A receipt item's stock values, or why they cannot be known (never guessed). */
function receiptValues(item: ProductionReceiptItemSnapshot): { finished: number; reject: number } | { issueCode: string; details: Record<string, unknown> } {
  if (item.qtyAccepted !== 0 && item.acceptedValue === null) return { issueCode: "receipt_value_missing", details: { goodsReceiptItemId: item.id, receiptNo: item.receiptNo, part: "accepted" } };
  if (item.qtyRejected !== 0 && item.rejectValue === null) return { issueCode: "receipt_value_missing", details: { goodsReceiptItemId: item.id, receiptNo: item.receiptNo, part: "rejected" } };
  return { finished: item.acceptedValue ?? 0, reject: item.rejectValue ?? 0 };
}

/** The Jakarta day production ended (R3's date), or null while the batch is still running. The
 * later of the close and the last receipt or return, so R3 always comes after what it settles. */
export function batchEndDate(batch: ProductionBatchSnapshot): string | null {
  if (batch.status !== "posted" || !batch.postedAt || !isEndedReceiptStatus(batch.receiptStatus)) return null;
  let date = jakartaDateOf(batch.postedAt);
  if (batch.receiptStatus === "closed" && batch.closedAt) date = laterDate(date, jakartaDateOf(batch.closedAt));
  for (const item of batch.receiptItems) date = laterDate(date, item.receivedAt);
  for (const movement of batch.defectReturns) date = laterDate(date, movement.occurredAt);
  return date;
}

/** The batch's 1-1503 balance from its own records as of the end of `asOf` (inclusive), before R3:
 * R1's cost − R2's values (net of reversals) + R5's returns (net of reversals). Null when a value is
 * unknown (an issue). Not dated: everything up to `asOf` counts. */
export function batchWipBeforeClose(batch: ProductionBatchSnapshot, asOf: string | null = null): number | null {
  if (batch.status !== "posted" || !batch.postedAt) return 0;
  if (asOf !== null && jakartaDateOf(batch.postedAt) > asOf) return 0;
  const cost = batchCost(batch);
  if ("issueCode" in cost) return null;
  let wip = cost.total;
  for (const item of batch.receiptItems) {
    if (asOf !== null && item.receivedAt > asOf) continue;
    const values = receiptValues(item);
    if ("issueCode" in values) return null;
    wip -= values.finished + values.reject;
  }
  for (const movement of batch.defectReturns) {
    if (asOf !== null && movement.occurredAt > asOf) continue;
    wip -= movement.valueAmount;
  }
  return wip;
}

/** The batch's work in progress as the app's records say it is at the end of `asOf`: 0 once
 * production ended on or before that day (R3 settled the rest), else batchWipBeforeClose. */
export function batchWipAsOf(batch: ProductionBatchSnapshot, asOf: string): number | null {
  const end = batchEndDate(batch);
  if (end !== null && end <= asOf) return 0;
  return batchWipBeforeClose(batch, asOf);
}

/** Per-payee balances on the three position accounts, at most one non-zero per payee. */
interface PayeePosition {
  supplierId: string | null;
  payable: number;
  advance: number;
  claim: number;
}

export interface PositionChange {
  supplierId: string | null;
  /** Credit-positive for payable, debit-positive for advance and claim. */
  payable: number;
  advance: number;
  claim: number;
}

type Step =
  | { kind: "post"; date: string; ts: number; id: string }
  | { kind: "payment"; date: string; ts: number; id: string; payment: ProductionPaymentSnapshot }
  | { kind: "payment_void"; date: string; ts: number; id: string; payment: ProductionPaymentSnapshot }
  | { kind: "end"; date: string; ts: number; id: string };

const STEP_RANK: Record<Step["kind"], number> = { post: 0, payment: 1, payment_void: 2, end: 3 };

function compareSteps(a: Step, b: Step): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (STEP_RANK[a.kind] !== STEP_RANK[b.kind]) return STEP_RANK[a.kind] - STEP_RANK[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function productionStepKey(kind: Step["kind"], id: string): string {
  return `${kind}:${id}`;
}

export interface ProductionChainResult {
  /** The position changes of every replayed step, by productionStepKey. */
  steps: Map<string, PositionChange[]>;
  /** The batch's position after the last step, per payee. */
  positions: PayeePosition[];
  blocked: { stepKey: string; issueCode: string; details: Record<string, unknown> } | null;
  blockedStepKeys: Set<string>;
}

/** The service bill's replay (exported for tests). The end step's own WIP rest is not part of it. */
export function replayProductionChain(batch: ProductionBatchSnapshot): ProductionChainResult {
  const steps: Step[] = [];
  const posted = batch.status === "posted" && batch.postedAt !== null;
  if (posted && batch.postedAt) steps.push({ kind: "post", date: jakartaDateOf(batch.postedAt), ts: batch.postedAt.getTime(), id: batch.id });
  for (const payment of batch.payments) {
    steps.push({ kind: "payment", date: payment.paidAt, ts: payment.createdAt.getTime(), id: payment.id, payment });
    if (payment.voidedAt) {
      const ts = Math.max(payment.voidedAt.getTime(), payment.createdAt.getTime());
      steps.push({ kind: "payment_void", date: laterDate(jakartaDateOf(payment.voidedAt), payment.paidAt), ts, id: payment.id, payment });
    }
  }
  const end = batchEndDate(batch);
  // The end step sorts after everything dated on its day (its timestamp is the day's last instant).
  if (end !== null) steps.push({ kind: "end", date: end, ts: Number.MAX_SAFE_INTEGER, id: batch.id });
  steps.sort(compareSteps);

  const result: ProductionChainResult = { steps: new Map(), positions: [], blocked: null, blockedStepKeys: new Set() };
  const net = new Map<string, number>();
  const balances = new Map<string, PayeePosition>();
  let ended = false;

  const positionOf = (supplierId: string | null): PayeePosition => {
    const key = payeeKey(supplierId);
    let position = balances.get(key);
    if (!position) {
      position = { supplierId, payable: 0, advance: 0, claim: 0 };
      balances.set(key, position);
    }
    return position;
  };
  /** Re-places every payee touched (or all, on a status change) and returns what moved, in a fixed
   * order (suppliers by id, the unattributed lines last) so the journal's lines, and so its content
   * hash, never depend on the order the database returned the cost lines in. */
  const settle = (keys: Iterable<string>): PositionChange[] => {
    const changes: PositionChange[] = [];
    const sorted = [...new Set(keys)].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a < b ? -1 : a > b ? 1 : 0));
    for (const key of sorted) {
      const current = balances.get(key);
      if (!current) continue;
      const n = net.get(key) ?? 0;
      const next = n >= 0 ? { payable: n, advance: 0, claim: 0 } : ended ? { payable: 0, advance: 0, claim: -n } : { payable: 0, advance: -n, claim: 0 };
      const change = { supplierId: current.supplierId, payable: next.payable - current.payable, advance: next.advance - current.advance, claim: next.claim - current.claim };
      Object.assign(current, next);
      if (change.payable !== 0 || change.advance !== 0 || change.claim !== 0) changes.push(change);
    }
    return changes;
  };
  const add = (supplierId: string | null, amount: number) => {
    positionOf(supplierId);
    const key = payeeKey(supplierId);
    net.set(key, (net.get(key) ?? 0) + amount);
    return key;
  };

  for (const step of steps) {
    const key = productionStepKey(step.kind, step.id);
    if (result.blocked) {
      result.blockedStepKeys.add(key);
      continue;
    }
    switch (step.kind) {
      case "post": {
        const cost = batchCost(batch);
        if ("issueCode" in cost) {
          result.blocked = { stepKey: key, issueCode: cost.issueCode, details: cost.details };
          result.blockedStepKeys.add(key);
          break;
        }
        const touched = new Set<string>();
        for (const line of batch.costLines) touched.add(add(line.supplierId, line.total));
        result.steps.set(key, settle(touched));
        break;
      }
      case "payment":
        result.steps.set(key, settle([add(step.payment.supplierId, -step.payment.amount)]));
        break;
      case "payment_void":
        result.steps.set(key, settle([add(step.payment.supplierId, step.payment.amount)]));
        break;
      case "end":
        ended = true;
        result.steps.set(key, settle([...balances.keys()]));
        break;
    }
  }
  result.positions = [...balances.values()];
  return result;
}

interface ProductionAccounts {
  wip: string;
  fabric: string;
  accessory: string;
  finished: string;
  defect: string;
  advance: string;
  claim: string;
}

function productionAccounts(context: PostingContext): ProductionAccounts {
  return {
    wip: systemAccount(context, "inventory.wip"),
    fabric: systemAccount(context, "inventory.fabric"),
    accessory: systemAccount(context, "inventory.accessory"),
    finished: systemAccount(context, "inventory.finished_goods"),
    defect: systemAccount(context, "inventory.defect"),
    advance: systemAccount(context, "prepaid.purchase_advance"),
    claim: systemAccount(context, "receivable.supplier_claim"),
  };
}

function payableAccount(context: PostingContext, supplierId: string | null): string {
  return supplierId
    ? mappedAccount(context, "supplier_payable.kind.service", "unmapped_supplier_payable", { targetType: "production_batch" })
    : mappedAccount(context, "supplier_payable.kind.no_supplier", "unmapped_supplier_payable", { targetType: "production_batch" });
}

/** A signed amount as one line: positive = debit, negative = credit, zero = no line. */
function signedLine(accountCode: string, debitPositive: number, extra: Partial<JournalLineDraft> = {}): JournalLineDraft[] {
  if (debitPositive === 0) return [];
  return [{ accountCode, debit: Math.max(debitPositive, 0), credit: Math.max(-debitPositive, 0), ...extra }];
}

function positionLines(context: PostingContext, accounts: ProductionAccounts, changes: readonly PositionChange[], cashAccountCode: string | null): JournalLineDraft[] {
  return changes.flatMap((change) => {
    const dims = { supplierId: change.supplierId, ...(cashAccountCode ? { cashAccountCode } : {}) };
    return [
      ...signedLine(payableAccount(context, change.supplierId), -change.payable, dims),
      ...signedLine(accounts.advance, change.advance, dims),
      ...signedLine(accounts.claim, change.claim, dims),
    ];
  });
}

/** Debits first, then credits, each in the order built; no lines = nothing to post. */
function journalOf(description: string, lines: JournalLineDraft[]): PostingOutcome {
  const ordered = [...lines.filter((line) => line.debit > 0), ...lines.filter((line) => line.credit > 0)];
  return ordered.length === 0 ? { kind: "none" } : { kind: "journal", description, lines: ordered };
}

export const PRODUCTION_CHAIN_RULE_VERSION = 2;

/** Every posting event of one production batch: R1 and R4 in chain order, R2, R5, then the
 * negations (so an original posted in this run is active before its negation is checked), then R3. */
export function productionChainEvents(batch: ProductionBatchSnapshot, context: PostingContext): PostingEvent[] {
  const chain = replayProductionChain(batch);
  const beforeStart = (date: string) => date < context.postingStartDate;
  const originals: PostingEvent[] = [];
  const negations: PostingEvent[] = [];
  const memo = batch.batchNo;
  const key = {
    batch: (event: string): PostingKey => ({ sourceType: PRODUCTION_BATCH_SOURCE_TYPE, sourceId: batch.id, sourceEvent: event }),
    receipt: (id: string, event: "received" | "reversed"): PostingKey => ({ sourceType: GOODS_RECEIPT_ITEM_SOURCE_TYPE, sourceId: id, sourceEvent: event }),
    payment: (id: string, event: "paid" | "void"): PostingKey => ({ sourceType: SUPPLIER_PAYMENT_SOURCE_TYPE, sourceId: id, sourceEvent: event }),
    returnOut: (id: string): PostingKey => ({ sourceType: DEFECT_MOVEMENT_SOURCE_TYPE, sourceId: id, sourceEvent: "return_out" }),
  };
  const blockedIssue = (): PostingOutcome => {
    const blocked = chain.blocked;
    if (!blocked) return { kind: "issue", issueCode: "production_chain_inconsistent", details: { batchNo: batch.batchNo } };
    return { kind: "issue", issueCode: blocked.issueCode, details: { ...blocked.details, blockedStep: blocked.stepKey } };
  };
  const changesOf = (kind: Step["kind"], id: string): PositionChange[] | null => {
    const stepKey = productionStepKey(kind, id);
    if (chain.blockedStepKeys.has(stepKey)) return null;
    return chain.steps.get(stepKey) ?? null;
  };

  // R1.
  if (batch.status === "posted" && batch.postedAt) {
    const postDate = jakartaDateOf(batch.postedAt);
    let outcome: PostingOutcome;
    if (beforeStart(postDate)) outcome = { kind: "none" };
    else if (batch.hasLegacyStock) outcome = { kind: "issue", issueCode: "legacy_batch_stock", details: { batchNo: batch.batchNo } };
    else {
      const changes = changesOf("post", batch.id);
      const cost = batchCost(batch);
      outcome =
        changes === null || "issueCode" in cost
          ? blockedIssue()
          : resolveOrIssue(() => {
              const accounts = productionAccounts(context);
              return journalOf(`Posting batch produksi ${batch.batchNo}`, [
                ...signedLine(accounts.wip, cost.total, { memo }),
                ...signedLine(accounts.fabric, -cost.fabric, { memo }),
                ...signedLine(accounts.accessory, -cost.accessory, { memo }),
                ...positionLines(context, accounts, changes, null),
              ]);
            });
    }
    originals.push({ key: key.batch("posted"), sourceDate: postDate, outcome });
  }

  // R4 and its void.
  for (const payment of batch.payments) {
    const payee = payment.supplierName ?? "tanpa pemasok";
    const paymentOutcome = (kind: "payment" | "payment_void", description: string): PostingOutcome => {
      const changes = changesOf(kind, payment.id);
      if (changes === null) return blockedIssue();
      return resolveOrIssue(() => {
        const accounts = productionAccounts(context);
        const cash = mappedAccount(context, `cash.method.${payment.method}`, "unmapped_payment_method", { method: payment.method });
        const cashSide = kind === "payment" ? -payment.amount : payment.amount;
        return journalOf(description, [...signedLine(cash, cashSide, { supplierId: payment.supplierId, cashAccountCode: cash }), ...positionLines(context, accounts, changes, cash)]);
      });
    };
    originals.push({
      key: key.payment(payment.id, "paid"),
      sourceDate: payment.paidAt,
      outcome: beforeStart(payment.paidAt) ? { kind: "none" } : paymentOutcome("payment", `Pembayaran produksi ${batch.batchNo} ke ${payee} (${payment.paymentNo})`),
    });
    if (payment.voidedAt) {
      negations.push({
        key: key.payment(payment.id, "void"),
        sourceDate: jakartaDateOf(payment.voidedAt),
        outcome: paymentOutcome("payment_void", `Pembatalan pembayaran ${payment.paymentNo}`),
        requiresActiveJournalFor: key.payment(payment.id, "paid"),
      });
    }
  }

  // R2 and its reversal.
  for (const item of batch.receiptItems) {
    const values = receiptValues(item);
    const outcome: PostingOutcome =
      "issueCode" in values
        ? { kind: "issue", issueCode: values.issueCode, details: values.details }
        : resolveOrIssue(() => {
            const accounts = productionAccounts(context);
            const itemMemo = `${batch.batchNo} ${item.sku}`;
            const description =
              item.kind === "receipt"
                ? `Penerimaan ${item.receiptNo} hasil produksi ${batch.batchNo}: ${item.sku}`
                : `Pembatalan penerimaan (${item.receiptNo}) hasil produksi ${batch.batchNo}: ${item.sku}`;
            return journalOf(description, [
              ...signedLine(accounts.finished, values.finished, { memo: itemMemo }),
              ...signedLine(accounts.defect, values.reject, { memo: `${itemMemo} (cacat)` }),
              ...signedLine(accounts.wip, -(values.finished + values.reject), { memo: itemMemo }),
            ]);
          });
    if (item.kind === "receipt") {
      originals.push({ key: key.receipt(item.id, "received"), sourceDate: item.receivedAt, outcome: beforeStart(item.receivedAt) ? { kind: "none" } : outcome });
    } else {
      negations.push({
        key: key.receipt(item.id, "reversed"),
        sourceDate: item.receivedAt,
        outcome: item.reversesItemId ? outcome : { kind: "issue", issueCode: "receipt_reversal_unmatched", details: { goodsReceiptItemId: item.id, receiptNo: item.receiptNo } },
        ...(item.reversesItemId ? { requiresActiveJournalFor: key.receipt(item.reversesItemId, "received") } : {}),
      });
    }
  }

  // R5 and its reversal.
  for (const movement of batch.defectReturns) {
    const outcome = resolveOrIssue(() => {
      const accounts = productionAccounts(context);
      const description =
        movement.type === "return_out"
          ? `Retur barang cacat ke penjahit, batch ${batch.batchNo}: ${movement.sku}`
          : `Pembatalan retur barang cacat ke penjahit, batch ${batch.batchNo}: ${movement.sku}`;
      // valueAmount is the defect ledger's own signed value: a return takes it out of 1-1506.
      return journalOf(description, [
        ...signedLine(accounts.wip, -movement.valueAmount, { memo: `${batch.batchNo} ${movement.sku}` }),
        ...signedLine(accounts.defect, movement.valueAmount, { memo: `${batch.batchNo} ${movement.sku} (cacat)` }),
      ]);
    });
    if (movement.type === "return_out") {
      originals.push({ key: key.returnOut(movement.id), sourceDate: movement.occurredAt, outcome: beforeStart(movement.occurredAt) ? { kind: "none" } : outcome });
    } else if (movement.reversesMovementId) {
      negations.push({ key: key.returnOut(movement.id), sourceDate: movement.occurredAt, outcome, requiresActiveJournalFor: key.returnOut(movement.reversesMovementId) });
    }
  }

  const events = [...originals, ...negations];

  // R3, for a posted batch only. "none" while running (reverses an R3 a reopen left behind).
  if (batch.status === "posted" && batch.postedAt && !batch.hasLegacyStock) {
    const end = batchEndDate(batch);
    let outcome: PostingOutcome = { kind: "none" };
    let sourceDate = jakartaDateOf(batch.postedAt);
    if (end !== null) {
      sourceDate = end;
      if (!beforeStart(end)) {
        const changes = changesOf("end", batch.id);
        const rest = batchWipBeforeClose(batch);
        if (changes === null) outcome = blockedIssue();
        else if (rest === null) outcome = { kind: "issue", issueCode: "receipt_value_missing", details: { batchNo: batch.batchNo, blockedStep: "wip_close" } };
        else {
          const closedEarly = batch.receiptStatus === "closed";
          outcome = resolveOrIssue(() => {
            const accounts = productionAccounts(context);
            const restAccount = closedEarly ? systemAccount(context, "expense.inventory_loss") : systemAccount(context, "cogs.production_variance");
            const description = closedEarly
              ? `Sisa biaya batch ${batch.batchNo} yang ditutup lebih awal`
              : `Selisih pembulatan biaya batch ${batch.batchNo} yang selesai`;
            return journalOf(description, [
              ...signedLine(restAccount, rest, { memo }),
              ...signedLine(accounts.wip, -rest, { memo }),
              ...positionLines(context, accounts, changes, null),
            ]);
          });
        }
      }
    }
    events.push({ key: key.batch("wip_close"), sourceDate, outcome });
  }
  return events;
}

export const productionChainRule: PostingRule<ProductionBatchSnapshot> = {
  name: "production_chain",
  // 2: supersedes the Session 2 batch-payment journals (rule supplier_payment v1, "without chain"),
  // so every R4/void is re-derived on the position rule (reverse + repost; a closed month's
  // difference lands in the first open month, D-23).
  ruleVersion: PRODUCTION_CHAIN_RULE_VERSION,
  events: productionChainEvents,
};

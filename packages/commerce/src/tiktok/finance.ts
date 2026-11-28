import "server-only";
import { sql } from "drizzle-orm";
import type { TikTokFeeSource, TikTokFinanceHeldReason, TikTokFinanceSnapshotKind, TikTokOrderFeeHeldReason } from "@ammari/db/schema";
import type {
  AllowlistedObject,
  TikTokFeeLine,
  TikTokFinanceProblem,
  TikTokOrderTransactionsProjection,
  TikTokPaymentProjection,
  TikTokStatementProjection,
  TikTokStatementTransactionProjection,
  TikTokUnsettledProjection,
} from "@ammari/tiktok-shop";
import { writeAuditLog, type Database, type Tx } from "../db";
import { isPostgresErrorCode } from "../errors";
import {
  TIKTOK_ORDER_TRANSACTION_TYPES,
  checkTikTokStatementSum,
  checkTikTokTransactionFeeSums,
  decideTikTokOrderFees,
  type TikTokFeeComponents,
  type TikTokFeeEvidence,
  type TikTokOrderFeeDecision,
} from "./finance-rules";

// The TikTok finance write path (docs/plans/tiktok-shop-integration.md §3.5, §5.3, T7). READ ONLY
// towards TikTok; here every write is idempotent and nothing settled is ever lost:
//
//   - every record (statement, statement transaction, order transactions, unsettled transaction,
//     payout) is versioned in tiktok_finance_snapshots by its content hash (`ON CONFLICT DO NOTHING`):
//     a re-fetch of the same content writes nothing, changed content adds a version;
//   - money that is not whole rupiah or not IDR holds the record (`held_reason`), never rounded;
//   - fee lines are TikTok's own fee type names, `estimate` (unsettled) and `actual` (statement
//     transactions by order) side by side: the actual never deletes the estimate;
//   - order_channel_fees is written only by `rebuildTikTokOrderFees`, under the order's advisory lock
//     (`tiktok-order:<id>`, the key T4-T6 take), with conditional upserts: actual over estimate, an
//     unknown fee type or a sum that does not add up holds the order (what was written stays), and an
//     order with no fee data gets no rows (never zero). Each change is one audit row (Log Aktivitas).
//
// No posting rule and no journal here (T8 consumes what this stores). Nothing here logs.

const ROW_LOCK_TIMEOUT = "10s";

function heldOf(problem: TikTokFinanceProblem | null): TikTokFinanceHeldReason | null {
  return problem;
}

async function lockOrder(tx: Tx, tiktokOrderId: string): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', ${ROW_LOCK_TIMEOUT}, true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-order:${tiktokOrderId}`}))`);
}

/** The snapshot row for this content; inserted unless the same content is already stored. */
async function snapshot(tx: Tx, kind: TikTokFinanceSnapshotKind, externalId: string, contentSha256: string, payload: AllowlistedObject, now: Date): Promise<{ id: string; inserted: boolean }> {
  const [inserted] = await tx.execute<{ id: string }>(sql`
    insert into tiktok_finance_snapshots (kind, external_id, content_sha256, payload, fetched_at)
    values (${kind}, ${externalId}, ${contentSha256}, ${JSON.stringify(payload)}::jsonb, ${now.toISOString()}::timestamptz)
    on conflict (kind, external_id, content_sha256) do nothing
    returning id
  `);
  if (inserted) return { id: inserted.id, inserted: true };
  const [existing] = await tx.execute<{ id: string }>(sql`
    select id from tiktok_finance_snapshots where kind = ${kind} and external_id = ${externalId} and content_sha256 = ${contentSha256}
  `);
  if (!existing) throw new Error("tiktok finance snapshot vanished");
  return { id: existing.id, inserted: false };
}

/** Replaces one transaction's lines of one source: upsert what TikTok reports now, delete what it no
 * longer reports (the history stays in the snapshots). Returns whether anything changed. */
async function replaceFeeLines(tx: Tx, tiktokOrderId: string, source: TikTokFeeSource, transactionId: string, lines: readonly TikTokFeeLine[], now: Date): Promise<boolean> {
  let changed = false;
  const keys: string[] = [];
  for (const item of lines) {
    keys.push(`${item.skuId}\u001f${item.group}\u001f${item.type}`);
    const rows = await tx.execute(sql`
      insert into tiktok_order_fee_lines (tiktok_order_id, source, transaction_id, tiktok_sku_id, fee_group, fee_type, amount, fetched_at)
      values (${tiktokOrderId}, ${source}, ${transactionId}, ${item.skuId}, ${item.group}, ${item.type}, ${item.amount}, ${now.toISOString()}::timestamptz)
      on conflict (source, transaction_id, tiktok_sku_id, fee_group, fee_type) do update
        set amount = excluded.amount, tiktok_order_id = excluded.tiktok_order_id, fetched_at = excluded.fetched_at, updated_at = now()
        where tiktok_order_fee_lines.amount is distinct from excluded.amount or tiktok_order_fee_lines.tiktok_order_id is distinct from excluded.tiktok_order_id
      returning id
    `);
    if (rows.length > 0) changed = true;
  }
  const stale = await tx.execute(sql`
    delete from tiktok_order_fee_lines
    where source = ${source} and transaction_id = ${transactionId}
      and (tiktok_sku_id || chr(31) || fee_group || chr(31) || fee_type) <> all (${sql.param(keys)}::text[])
    returning id
  `);
  return changed || stale.length > 0;
}

// ---- Unsettled transactions (estimates) ---------------------------------------------------------

export interface StoreTikTokFinanceResult {
  snapshot: "inserted" | "replay";
  /** The TikTok order whose fees may need a rebuild, if any. */
  tiktokOrderId: string | null;
}

export async function storeTikTokUnsettledTransaction(db: Database, record: TikTokUnsettledProjection, now: Date): Promise<StoreTikTokFinanceResult> {
  const orderTransaction = record.tiktokOrderId !== null && TIKTOK_ORDER_TRANSACTION_TYPES.has(record.type);
  return db.transaction(async (tx) => {
    if (orderTransaction) await lockOrder(tx, record.tiktokOrderId!);
    const snap = await snapshot(tx, "unsettled_transaction", record.transactionId, record.contentSha256, record.payload, now);
    // The estimate's lines must add up to its own estimated totals, like the actual's (an absent or
    // renamed breakdown never reads as "no fees").
    const held: TikTokFinanceHeldReason | null =
      heldOf(record.problem) ?? (orderTransaction && !checkTikTokTransactionFeeSums(record.fees, { feeTax: record.amounts.feeTax, shippingCost: record.amounts.shippingCost }) ? "sum_mismatch" : null);
    const { settlement, revenue, feeTax, shippingCost } = record.amounts;
    await tx.execute(sql`
      insert into tiktok_unsettled_transactions (transaction_id, type, tiktok_order_id, est_settlement_amount, est_revenue_amount, est_fee_tax_amount, est_shipping_cost_amount, held_reason, content_sha256, latest_snapshot_id, first_seen_at, last_seen_at)
      values (${record.transactionId}, ${record.type}, ${record.tiktokOrderId}, ${settlement}, ${revenue}, ${feeTax}, ${shippingCost}, ${held}, ${record.contentSha256}, ${snap.id}::uuid, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
      on conflict (transaction_id) do update set
        type = excluded.type, tiktok_order_id = excluded.tiktok_order_id, est_settlement_amount = excluded.est_settlement_amount, est_revenue_amount = excluded.est_revenue_amount,
        est_fee_tax_amount = excluded.est_fee_tax_amount, est_shipping_cost_amount = excluded.est_shipping_cost_amount, held_reason = excluded.held_reason,
        content_sha256 = excluded.content_sha256, latest_snapshot_id = excluded.latest_snapshot_id, last_seen_at = excluded.last_seen_at,
        updated_at = case when tiktok_unsettled_transactions.content_sha256 is distinct from excluded.content_sha256 then now() else tiktok_unsettled_transactions.updated_at end
    `);
    // A held estimate keeps its old lines but they are not used (the evidence reads it as held).
    if (orderTransaction && held === null) await replaceFeeLines(tx, record.tiktokOrderId!, "estimate", record.transactionId, record.fees, now);
    return { snapshot: snap.inserted ? "inserted" : "replay", tiktokOrderId: orderTransaction ? record.tiktokOrderId : null };
  });
}

// ---- Statements and their transactions (actuals) ------------------------------------------------

export interface StoreTikTokStatementResult {
  snapshot: "inserted" | "replay";
  /** Its transactions are not stored (and checked) for this content yet. */
  needsTransactions: boolean;
}

export async function storeTikTokStatement(db: Database, record: TikTokStatementProjection, now: Date): Promise<StoreTikTokStatementResult> {
  return db.transaction(async (tx) => {
    const snap = await snapshot(tx, "statement", record.statementId, record.contentSha256, record.payload, now);
    const own = heldOf(record.problem);
    const { settlement, revenue, fee, adjustment, shippingCost } = record.amounts;
    // The held reason is reset only when the content changed: a `sum_mismatch` found by the
    // transaction check stays on the same content (the transactions step re-checks it).
    const [row] = await tx.execute<{ transactions_complete_sha256: string | null }>(sql`
      insert into tiktok_statements (statement_id, statement_time, currency, settlement_amount, revenue_amount, fee_amount, adjustment_amount, shipping_cost_amount, payment_status, payment_id, held_reason, latest_snapshot_id, first_seen_at, fetched_at)
      values (${record.statementId}, ${record.statementTime.toISOString()}::timestamptz, ${record.currency}, ${settlement}, ${revenue}, ${fee}, ${adjustment}, ${shippingCost}, ${record.paymentStatus}, ${record.paymentId}, ${own}, ${snap.id}::uuid, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
      on conflict (statement_id) do update set
        statement_time = excluded.statement_time, currency = excluded.currency, settlement_amount = excluded.settlement_amount, revenue_amount = excluded.revenue_amount,
        fee_amount = excluded.fee_amount, adjustment_amount = excluded.adjustment_amount, shipping_cost_amount = excluded.shipping_cost_amount,
        payment_status = excluded.payment_status, payment_id = excluded.payment_id, fetched_at = excluded.fetched_at,
        held_reason = case when tiktok_statements.latest_snapshot_id is distinct from excluded.latest_snapshot_id then excluded.held_reason else coalesce(excluded.held_reason, tiktok_statements.held_reason) end,
        latest_snapshot_id = excluded.latest_snapshot_id,
        updated_at = case when tiktok_statements.latest_snapshot_id is distinct from excluded.latest_snapshot_id then now() else tiktok_statements.updated_at end
      returning transactions_complete_sha256
    `);
    const needsTransactions = own === null && row!.transactions_complete_sha256 !== record.contentSha256;
    return { snapshot: snap.inserted ? "inserted" : "replay", needsTransactions };
  });
}

export interface StoreTikTokStatementTransactionsResult {
  inserted: number;
  replays: number;
  /** Σ transactions = settlement, and every transaction readable. */
  complete: boolean;
  heldReason: TikTokFinanceHeldReason | null;
  /** TikTok orders with order transactions in this statement (fees to fetch and rebuild). */
  tiktokOrderIds: string[];
}

/** Stores every transaction of one statement (all pages, gathered by the caller) and checks that
 * they add up to its settlement. A transaction whose content changed needs its SKU lines again. */
export async function storeTikTokStatementTransactions(
  db: Database,
  statement: { statementId: string; contentSha256: string },
  records: readonly TikTokStatementTransactionProjection[],
  now: Date,
  /** Entries TikTok listed that could not be identified: the statement can then never be complete. */
  invalid = 0,
): Promise<StoreTikTokStatementTransactionsResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', ${ROW_LOCK_TIMEOUT}, true)`);
    const [current] = await tx.execute<{ settlement_amount: string | number | null; held_reason: string | null; latest_sha: string | null }>(sql`
      select s.settlement_amount, s.held_reason, f.content_sha256 as latest_sha
      from tiktok_statements s join tiktok_finance_snapshots f on f.id = s.latest_snapshot_id
      where s.statement_id = ${statement.statementId} for update of s
    `);
    if (!current) throw new Error("tiktok statement not stored");
    const result: StoreTikTokStatementTransactionsResult = { inserted: 0, replays: 0, complete: false, heldReason: null, tiktokOrderIds: [] };
    const orders = new Set<string>();
    for (const record of records) {
      const snap = await snapshot(tx, "statement_transaction", record.transactionId, record.contentSha256, record.payload, now);
      if (snap.inserted) result.inserted += 1;
      else result.replays += 1;
      const isOrder = record.tiktokOrderId !== null && TIKTOK_ORDER_TRANSACTION_TYPES.has(record.type);
      const held = heldOf(record.problem);
      const feesState = isOrder ? "pending" : null;
      const { settlement, revenue, feeTax, shippingCost, adjustment } = record.amounts;
      await tx.execute(sql`
        insert into tiktok_statement_transactions (transaction_id, statement_id, type, kind, tiktok_order_id, settlement_amount, revenue_amount, fee_tax_amount, shipping_cost_amount, adjustment_amount, held_reason, fees_state, content_sha256, latest_snapshot_id, fetched_at)
        values (${record.transactionId}, ${record.statementId}, ${record.type}, ${isOrder ? "order" : "adjustment"}, ${record.tiktokOrderId}, ${settlement}, ${revenue}, ${feeTax}, ${shippingCost}, ${adjustment}, ${held}, ${feesState}, ${record.contentSha256}, ${snap.id}::uuid, ${now.toISOString()}::timestamptz)
        on conflict (transaction_id) do update set
          statement_id = excluded.statement_id, type = excluded.type, kind = excluded.kind, tiktok_order_id = excluded.tiktok_order_id,
          settlement_amount = excluded.settlement_amount, revenue_amount = excluded.revenue_amount, fee_tax_amount = excluded.fee_tax_amount,
          shipping_cost_amount = excluded.shipping_cost_amount, adjustment_amount = excluded.adjustment_amount, held_reason = excluded.held_reason,
          latest_snapshot_id = excluded.latest_snapshot_id, fetched_at = excluded.fetched_at,
          -- Changed content: its SKU lines must be fetched and checked again.
          fees_state = case when tiktok_statement_transactions.content_sha256 is distinct from excluded.content_sha256 then excluded.fees_state else tiktok_statement_transactions.fees_state end,
          fees_held_reason = case when tiktok_statement_transactions.content_sha256 is distinct from excluded.content_sha256 then null else tiktok_statement_transactions.fees_held_reason end,
          content_sha256 = excluded.content_sha256,
          updated_at = case when tiktok_statement_transactions.content_sha256 is distinct from excluded.content_sha256 then now() else tiktok_statement_transactions.updated_at end
      `);
      if (isOrder) orders.add(record.tiktokOrderId!);
    }
    const unreadable = records.some((record) => record.problem !== null) || invalid > 0;
    const settlement = current.settlement_amount === null ? null : Number(current.settlement_amount);
    const adds = checkTikTokStatementSum(settlement, records.map((record) => record.amounts.settlement));
    result.heldReason = unreadable ? "money_format" : adds ? null : "sum_mismatch";
    result.complete = result.heldReason === null;
    // Only for the content the transactions were fetched for: a newer statement version arriving in
    // between keeps its own state.
    if (current.latest_sha === statement.contentSha256) {
      await tx.execute(sql`
        update tiktok_statements set
          held_reason = ${result.heldReason},
          transactions_complete_sha256 = ${result.complete ? statement.contentSha256 : null},
          updated_at = now()
        where statement_id = ${statement.statementId}
      `);
    }
    result.tiktokOrderIds = [...orders];
    return result;
  });
}

export interface StoreTikTokOrderTransactionsResult {
  /** Order transactions whose SKU lines are now stored and add up. */
  complete: number;
  held: number;
  /** Stored order transactions TikTok did not return in this answer (still pending). */
  missing: number;
}

/** Get Transactions by Order → `actual` lines for each of the order's stored statement transactions,
 * checked against that transaction's totals. */
export async function storeTikTokOrderTransactions(db: Database, projection: TikTokOrderTransactionsProjection, now: Date): Promise<StoreTikTokOrderTransactionsResult> {
  return db.transaction(async (tx) => {
    await lockOrder(tx, projection.tiktokOrderId);
    await snapshot(tx, "order_transactions", projection.tiktokOrderId, projection.contentSha256, projection.payload, now);
    const stored = await tx.execute<{ transaction_id: string; fee_tax_amount: string | number | null; shipping_cost_amount: string | number | null; held_reason: string | null }>(sql`
      select transaction_id, fee_tax_amount, shipping_cost_amount, held_reason from tiktok_statement_transactions
      where tiktok_order_id = ${projection.tiktokOrderId} and kind = 'order'
      for update
    `);
    const byId = new Map(projection.transactions.map((item) => [item.transactionId, item]));
    const result: StoreTikTokOrderTransactionsResult = { complete: 0, held: 0, missing: 0 };
    for (const row of stored) {
      const fetched = byId.get(row.transaction_id);
      if (!fetched) {
        // Still pending; touched so the queue (oldest attempt first) moves past it and an order TikTok
        // keeps not returning never starves the others.
        await tx.execute(sql`update tiktok_statement_transactions set updated_at = now() where transaction_id = ${row.transaction_id}`);
        result.missing += 1;
        continue;
      }
      let reason: TikTokOrderFeeHeldReason | null = null;
      if (row.held_reason !== null || fetched.problem !== null) reason = "money_format";
      else {
        await replaceFeeLines(tx, projection.tiktokOrderId, "actual", row.transaction_id, fetched.fees, now);
        const totals = { feeTax: row.fee_tax_amount === null ? null : Number(row.fee_tax_amount), shippingCost: row.shipping_cost_amount === null ? null : Number(row.shipping_cost_amount) };
        if (!checkTikTokTransactionFeeSums(fetched.fees, totals)) reason = "fee_sum_mismatch";
      }
      await tx.execute(sql`
        update tiktok_statement_transactions set fees_state = ${reason ? "held" : "complete"}, fees_held_reason = ${reason}, updated_at = now()
        where transaction_id = ${row.transaction_id}
      `);
      if (reason) result.held += 1;
      else result.complete += 1;
    }
    return result;
  });
}

/** Order transactions whose SKU lines are still to fetch, least recently tried first (one TikTok call
 * per order; storeTikTokOrderTransactions touches the ones TikTok did not return). */
export async function listTikTokOrdersWithPendingFees(db: Database, limit = 100): Promise<string[]> {
  const rows = await db.execute<{ tiktok_order_id: string }>(sql`
    select tiktok_order_id from tiktok_statement_transactions
    where fees_state = 'pending' and tiktok_order_id is not null
    group by tiktok_order_id order by min(updated_at) limit ${limit}
  `);
  return rows.map((row) => row.tiktok_order_id);
}

// ---- Payouts ---------------------------------------------------------------------------------

export async function storeTikTokPayout(db: Database, record: TikTokPaymentProjection, now: Date): Promise<{ snapshot: "inserted" | "replay" }> {
  return db.transaction(async (tx) => {
    const snap = await snapshot(tx, "payment", record.paymentId, record.contentSha256, record.payload, now);
    await tx.execute(sql`
      insert into tiktok_payouts (payment_id, amount, currency, status, create_time, paid_time, bank_account_last4, held_reason, content_sha256, latest_snapshot_id, fetched_at)
      values (${record.paymentId}, ${record.amount}, ${record.currency}, ${record.status}, ${record.createTime?.toISOString() ?? null}::timestamptz, ${record.paidTime?.toISOString() ?? null}::timestamptz,
        ${record.bankAccountLast4}, ${heldOf(record.problem)}, ${record.contentSha256}, ${snap.id}::uuid, ${now.toISOString()}::timestamptz)
      on conflict (payment_id) do update set
        amount = excluded.amount, currency = excluded.currency, status = excluded.status, create_time = excluded.create_time, paid_time = excluded.paid_time,
        bank_account_last4 = excluded.bank_account_last4, held_reason = excluded.held_reason, latest_snapshot_id = excluded.latest_snapshot_id, fetched_at = excluded.fetched_at,
        updated_at = case when tiktok_payouts.content_sha256 is distinct from excluded.content_sha256 then now() else tiktok_payouts.updated_at end,
        content_sha256 = excluded.content_sha256
    `);
    return { snapshot: snap.inserted ? "inserted" : "replay" };
  });
}

export interface TikTokPayoutStatementLink {
  paymentId: string;
  amount: number | null;
  statementCount: number;
  /** Σ settlement of the statements this payout paid (held statements counted as unknown). */
  statementsTotal: number | null;
  matches: boolean;
}

/** Payout ↔ statements (plan §5.4 check (c) reads this in T8): a payout pays the statements that
 * name its `payment_id`. */
export async function getTikTokPayoutStatementLinks(db: Database, paymentIds: readonly string[]): Promise<TikTokPayoutStatementLink[]> {
  if (paymentIds.length === 0) return [];
  const rows = await db.execute<{ payment_id: string; amount: string | number | null; statement_count: number; statements_total: string | number | null; unknown: number }>(sql`
    select p.payment_id, p.amount, count(s.statement_id)::int as statement_count,
      sum(s.settlement_amount) as statements_total,
      count(*) filter (where s.statement_id is not null and (s.settlement_amount is null or s.held_reason is not null))::int as unknown
    from tiktok_payouts p left join tiktok_statements s on s.payment_id = p.payment_id
    where p.payment_id = any(${sql.param([...paymentIds])}::text[])
    group by p.payment_id, p.amount
  `);
  return rows.map((row) => {
    const amount = row.amount === null ? null : Number(row.amount);
    const total = row.unknown > 0 || row.statements_total === null ? null : Number(row.statements_total);
    return { paymentId: row.payment_id, amount, statementCount: row.statement_count, statementsTotal: total, matches: amount !== null && total !== null && amount === total };
  });
}

// ---- order_channel_fees ------------------------------------------------------------------------

function estimateHeld(reasons: readonly (TikTokFinanceHeldReason | null)[]): TikTokOrderFeeHeldReason | null {
  if (reasons.includes("sum_mismatch")) return "fee_sum_mismatch";
  return reasons.some((reason) => reason !== null) ? "money_format" : null;
}

async function loadEvidence(tx: Tx, tiktokOrderId: string): Promise<TikTokFeeEvidence> {
  const types = [...TIKTOK_ORDER_TRANSACTION_TYPES];
  const unsettled = await tx.execute<{ transaction_id: string; held_reason: TikTokFinanceHeldReason | null }>(sql`
    select transaction_id, held_reason from tiktok_unsettled_transactions
    where tiktok_order_id = ${tiktokOrderId} and type = any(${sql.param(types)}::text[])
  `);
  // A statement that is held (its transactions do not add up, or one cannot be read) holds the actuals
  // of every order in it, even when that order's own SKU lines add up.
  const settled = await tx.execute<{ transaction_id: string; held_reason: string | null; fees_state: string | null; fees_held_reason: TikTokOrderFeeHeldReason | null; statement_held: string | null }>(sql`
    select t.transaction_id, t.held_reason, t.fees_state, t.fees_held_reason, s.held_reason as statement_held
    from tiktok_statement_transactions t join tiktok_statements s on s.statement_id = t.statement_id
    where t.tiktok_order_id = ${tiktokOrderId} and t.kind = 'order'
  `);
  const lines = await tx.execute<{ source: TikTokFeeSource; transaction_id: string; tiktok_sku_id: string; fee_group: "fee" | "tax" | "shipping"; fee_type: string; amount: string | number }>(sql`
    select source, transaction_id, tiktok_sku_id, fee_group, fee_type, amount from tiktok_order_fee_lines where tiktok_order_id = ${tiktokOrderId}
  `);
  const usableEstimates = new Set(unsettled.filter((row) => row.held_reason === null).map((row) => row.transaction_id));
  const completeActuals = new Set(settled.filter((row) => row.fees_state === "complete").map((row) => row.transaction_id));
  const toLine = (row: (typeof lines)[number]) => ({ skuId: row.tiktok_sku_id, group: row.fee_group, type: row.fee_type, amount: Number(row.amount) });
  const heldSettled = settled.find((row) => row.held_reason !== null || row.fees_state === "held" || row.statement_held !== null);
  return {
    estimate: {
      lines: lines.filter((row) => row.source === "estimate" && usableEstimates.has(row.transaction_id)).map(toLine),
      held: estimateHeld(unsettled.map((row) => row.held_reason)),
      transactions: unsettled.length,
    },
    actual: {
      lines: lines.filter((row) => row.source === "actual" && completeActuals.has(row.transaction_id)).map(toLine),
      held: heldSettled ? (heldSettled.fees_held_reason ?? (heldSettled.held_reason !== null || heldSettled.statement_held === "money_format" ? "money_format" : "fee_sum_mismatch")) : null,
      pending: settled.filter((row) => row.fees_state === "pending" || row.fees_state === null).length,
      transactions: settled.length,
    },
  };
}

export type RebuildTikTokOrderFeesResult =
  | { kind: "none" }
  | { kind: "waiting_order" }
  | { kind: "held"; reason: TikTokOrderFeeHeldReason }
  | { kind: "applied"; source: TikTokFeeSource; changed: boolean }
  | { kind: "busy"; code: string };

type FeeStateRow = { order_id: string | null; state: string; held_reason: string | null; source: string | null; unmapped_types: string[]; applied_components: Record<string, number> | null; applied_source: string | null };

async function saveState(tx: Tx, tiktokOrderId: string, orderId: string | null, decision: Exclude<TikTokOrderFeeDecision, { kind: "none" }>, state: "applied" | "held" | "waiting_order", previous: FeeStateRow | undefined, applied?: { components: TikTokFeeComponents; source: TikTokFeeSource; now: Date }): Promise<boolean> {
  const heldReason = state === "held" && decision.kind === "held" ? decision.reason : state === "held" ? "not_tiktok_order" : null;
  const unmapped = decision.kind === "held" ? decision.unmappedTypes : [];
  const appliedComponents = applied ? JSON.stringify(applied.components) : previous?.applied_components ? JSON.stringify(previous.applied_components) : null;
  const rows = await tx.execute(sql`
    insert into tiktok_order_fees (tiktok_order_id, order_id, state, held_reason, source, applied_source, unmapped_types, applied_components, applied_at)
    values (${tiktokOrderId}, ${orderId}::uuid, ${state}, ${heldReason}, ${decision.source}, ${applied?.source ?? previous?.applied_source ?? null},
      ${sql.param(unmapped)}::text[], ${appliedComponents}::jsonb, ${applied ? applied.now.toISOString() : null}::timestamptz)
    on conflict (tiktok_order_id) do update set
      order_id = excluded.order_id, state = excluded.state, held_reason = excluded.held_reason, source = excluded.source,
      applied_source = excluded.applied_source, unmapped_types = excluded.unmapped_types, applied_components = excluded.applied_components,
      applied_at = coalesce(excluded.applied_at, tiktok_order_fees.applied_at), updated_at = now()
    where (tiktok_order_fees.order_id, tiktok_order_fees.state, tiktok_order_fees.held_reason, tiktok_order_fees.source, tiktok_order_fees.applied_source, tiktok_order_fees.unmapped_types, tiktok_order_fees.applied_components)
      is distinct from (excluded.order_id, excluded.state, excluded.held_reason, excluded.source, excluded.applied_source, excluded.unmapped_types, excluded.applied_components)
    returning tiktok_order_id
  `);
  if (rows.length > 0) return true;
  // Unchanged: only the attempt time moves, so a held order goes to the back of the re-check queue
  // (listTikTokOrderFeesToRebuild, least recently tried first) and never starves the others.
  await tx.execute(sql`update tiktok_order_fees set updated_at = now() where tiktok_order_id = ${tiktokOrderId}`);
  return false;
}

/** Rebuilds one TikTok order's order_channel_fees from the stored lines (actual over estimate).
 * Serialized per order; a replay changes nothing. */
export async function rebuildTikTokOrderFees(db: Database, tiktokOrderId: string, options: { now: Date }): Promise<RebuildTikTokOrderFeesResult> {
  try {
    return await db.transaction(async (tx) => {
      await lockOrder(tx, tiktokOrderId);
      const evidence = await loadEvidence(tx, tiktokOrderId);
      const decision = decideTikTokOrderFees(evidence);
      const [previous] = await tx.execute<FeeStateRow>(sql`
        select order_id, state, held_reason, source, unmapped_types, applied_components, applied_source from tiktok_order_fees where tiktok_order_id = ${tiktokOrderId} for update
      `);
      if (decision.kind === "none") return { kind: "none" };
      const [link] = await tx.execute<{ order_id: string | null }>(sql`select order_id from tiktok_orders where tiktok_order_id = ${tiktokOrderId}`);
      const orderId = link?.order_id ?? null;
      if (!orderId) {
        await saveState(tx, tiktokOrderId, null, decision, "waiting_order", previous);
        return { kind: "waiting_order" };
      }
      const [order] = await tx.execute<{ channel_id: string }>(sql`select channel_id from orders where id = ${orderId}::uuid for update`);
      if (order?.channel_id !== "tiktok") {
        // Never touch another channel's fees (should never happen: tiktok_orders links TikTok orders only).
        await saveState(tx, tiktokOrderId, orderId, decision, "held", previous);
        return { kind: "held", reason: "not_tiktok_order" };
      }
      if (decision.kind === "held") {
        const changed = await saveState(tx, tiktokOrderId, orderId, decision, "held", previous);
        if (changed && previous?.state !== "held") {
          await writeAuditLog(tx, { actorStaffUserId: null, action: "tiktok_fees_hold", entityType: "order", entityId: orderId, before: previous ? { state: previous.state, source: previous.applied_source } : null, after: { reason: decision.reason, source: decision.source, unmappedTypes: decision.unmappedTypes } });
        }
        return { kind: "held", reason: decision.reason };
      }
      // Components written earlier but absent now go to 0 (the actual replaced the estimate).
      const target: Record<string, number> = {};
      for (const component of Object.keys(previous?.applied_components ?? {})) target[component] = 0;
      Object.assign(target, decision.components);
      const before = await tx.execute<{ component: string; amount: string | number; source: string }>(sql`
        select component, amount, source from order_channel_fees where order_id = ${orderId}::uuid order by component
      `);
      let changed = false;
      for (const [component, amount] of Object.entries(target).sort(([a], [b]) => a.localeCompare(b))) {
        const existing = before.find((row) => row.component === component);
        if (!existing && amount === 0) continue;
        const rows = await tx.execute(sql`
          insert into order_channel_fees (order_id, component, amount, source)
          values (${orderId}::uuid, ${component}, ${amount}, ${decision.source})
          on conflict (order_id, component) do update set amount = excluded.amount, source = excluded.source, import_batch_id = null, updated_at = now()
          where (order_channel_fees.amount, order_channel_fees.source) is distinct from (excluded.amount, excluded.source)
          returning id
        `);
        if (rows.length > 0) changed = true;
      }
      const applied = Object.fromEntries(Object.entries(target).filter(([, amount]) => amount > 0)) as TikTokFeeComponents;
      await saveState(tx, tiktokOrderId, orderId, decision, "applied", previous, { components: applied, source: decision.source, now: options.now });
      if (changed) {
        await writeAuditLog(tx, {
          actorStaffUserId: null,
          action: "tiktok_fees_update",
          entityType: "order",
          entityId: orderId,
          before: { fees: Object.fromEntries(before.map((row) => [row.component, Number(row.amount)])), source: previous?.applied_source ?? null },
          after: { fees: applied, source: decision.source },
        });
      }
      return { kind: "applied", source: decision.source, changed };
    });
  } catch (error) {
    if (isPostgresErrorCode(error, "55P03")) return { kind: "busy", code: "lock_timeout" };
    if (isPostgresErrorCode(error, "40P01")) return { kind: "busy", code: "deadlock" };
    throw error;
  }
}

/** Orders whose fees waited for their admin order and now have one, plus held ones (a statement
 * fixed since): re-checked every finance run without a TikTok call. */
export async function listTikTokOrderFeesToRebuild(db: Database, limit = 200): Promise<string[]> {
  const rows = await db.execute<{ tiktok_order_id: string }>(sql`
    select f.tiktok_order_id from tiktok_order_fees f
    left join tiktok_orders o on o.tiktok_order_id = f.tiktok_order_id
    where (f.state = 'waiting_order' and o.order_id is not null) or f.state = 'held'
    order by f.updated_at limit ${limit}
  `);
  return rows.map((row) => row.tiktok_order_id);
}

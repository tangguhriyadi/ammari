import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { applyAllowlist, type AllowlistSpec, type AllowlistedObject } from "./allowlist";
import { TikTokApiError, type TikTokClient } from "./client";
import { FINANCE_MAX_PAGE_SIZE, TIKTOK_ENDPOINTS } from "./endpoints";
import { canonicalJson, isTikTokOrderId, storable, tiktokSeconds } from "./orders";
import { TikTokMoneyFormatError, parseRupiah } from "./rupiah";
import type { Secret } from "./secret";

// The finance read side towards TikTok (docs/plans/tiktok-shop-integration.md §0 "Finance", §3.5, §5.3,
// §5.4; T7). READ ONLY (decided Q15): Get Unsettled Transactions, Get Statements, Get Transactions by
// Statement, Get Transactions by Order (SKU-level fees) and Get Payments. Nothing here writes to TikTok.
//
// A raw record never leaves this module: each is allowlisted, its amounts parsed with the strict
// whole-rupiah parser (Q6: anything else is a `money_format` problem, never rounded), and versioned by
// the SHA-256 of its allowlisted content (finance records have no `update_time`).
//
// Fee breakdowns are open maps: their keys ARE TikTok's fee type names (e.g.
// `platform_commission_amount`), and TikTok adds new ones. They are read generically, never through a
// list of expected names, so an unknown type is kept under its own name (commerce/tiktok/finance-rules.ts
// holds it as `fee_type_unmapped`), never dropped or summed into something else. Only keys in
// snake_case and values that look like an amount survive, so no free text can ride in one.
//
// Field and endpoint names follow TikTok's finance objects as documented for 202309/202501/202507 and are
// checked against a real response on the development shop (T0), like the order fields (§9.1). A field
// TikTok names differently is simply absent: an absent settlement amount is a `money_format` problem,
// an absent breakdown means no fee lines, and the sum checks in commerce then hold the order.

export type TikTokFeeGroup = "fee" | "tax" | "shipping";

/** TikTok transaction types that carry an order's own money (and its fees). Such a transaction must
 * name its order: one that does not cannot be attributed and is refused (counted as invalid, holds the
 * cursor), never stored as an adjustment. Every other type is an adjustment, kept as received. */
export const TIKTOK_ORDER_TRANSACTION_TYPES: ReadonlySet<string> = new Set(["ORDER", "REFUND"]);
export const TIKTOK_FEE_GROUPS: readonly TikTokFeeGroup[] = ["fee", "tax", "shipping"];

/** Why a finance record's money could not be read. Never rounded, never defaulted. */
export type TikTokFinanceProblem = "money_format" | "currency";

/** One fee amount as TikTok reports it: signed, TikTok's own type name. `skuId` is "" for an
 * order-level line (an unsettled transaction has no SKU split). */
export interface TikTokFeeLine {
  skuId: string;
  group: TikTokFeeGroup;
  type: string;
  amount: number;
}

const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const BREAKDOWN_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** What a breakdown value may look like to be stored at all (the parser then decides). */
const AMOUNT_LIKE = /^[-+0-9.,eE ]{1,40}$/;

function isId(value: unknown): value is string {
  // `.`/`..` would be a path segment once in an endpoint path (encodeURIComponent keeps them).
  return typeof value === "string" && ID_PATTERN.test(value) && value !== "." && value !== "..";
}

/** What may be stored from a fixed (non-breakdown) field: a token without spaces (an id, a code, an
 * amount string), a number or a boolean. Anything else (free text, an array, an over-long value) is
 * dropped, so a field TikTok fills with a note or an address never reaches the database even though
 * its name is on the allowlist. Nested objects (a payout's `amount`) are filtered the same way. */
const TOKEN = /^[\x21-\x7e]{1,128}$/;
function tokensOnly(object: AllowlistedObject): AllowlistedObject {
  const kept: AllowlistedObject = {};
  for (const [key, value] of Object.entries(object)) {
    let keep: AllowlistedObject[string] | undefined;
    if (typeof value === "string") keep = TOKEN.test(value) ? value : undefined;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) keep = value;
    else if (typeof value === "object" && !Array.isArray(value)) keep = tokensOnly(value as AllowlistedObject);
    if (keep !== undefined) Object.defineProperty(kept, key, { value: keep, enumerable: true, writable: true, configurable: true });
  }
  return kept;
}

function allowlisted(source: Record<string, unknown>, spec: AllowlistSpec): AllowlistedObject {
  return tokensOnly(applyAllowlist(source, spec));
}

function code(value: unknown): string | null {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : null;
}

function secondsToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000) : null;
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function sha256(payload: AllowlistedObject): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/** Collects the first money problem of a record; parsing goes on so the payload stays complete. */
class MoneyReader {
  problem: TikTokFinanceProblem | null = null;
  field: string | null = null;

  fail(problem: TikTokFinanceProblem, field: string): void {
    if (this.problem === null) {
      this.problem = problem;
      this.field = field;
    }
  }

  /** A signed amount, or null when absent. Present but not whole rupiah → problem. */
  optional(value: unknown, field: string): number | null {
    if (value === undefined || value === null) return null;
    try {
      return parseRupiah(value, { allowNegative: true, field });
    } catch (error) {
      if (!(error instanceof TikTokMoneyFormatError)) throw error;
      this.fail("money_format", field);
      return null;
    }
  }

  /** Absent counts as a problem too: the record cannot be booked without it. */
  required(value: unknown, field: string): number | null {
    if (value === undefined || value === null) {
      this.fail("money_format", field);
      return null;
    }
    return this.optional(value, field);
  }

  /** `IDR` or absent (when `required` is false); anything else is a currency problem. */
  currency(value: unknown, field: string, required: boolean): string | null {
    if (value === undefined || value === null) {
      if (required) this.fail("currency", field);
      return null;
    }
    if (value !== "IDR") this.fail("currency", field);
    return typeof value === "string" ? value.slice(0, 8) : null;
  }
}

/** A breakdown object → fee lines (TikTok's type names) + its storable copy. One nested level is
 * flattened as `parent.child` (e.g. a shipping `supplementary_component`). Deeper nesting, a key that
 * is not snake_case, or a value that is not a whole-rupiah string → money_format (named), never
 * dropped silently. */
function readBreakdown(raw: unknown, group: TikTokFeeGroup, skuId: string, money: MoneyReader, path: string, lines: TikTokFeeLine[]): AllowlistedObject | undefined {
  if (raw === undefined || raw === null) return undefined;
  const object = record(raw);
  if (raw !== object) {
    money.fail("money_format", path);
    return undefined;
  }
  const kept: AllowlistedObject = {};
  const visit = (source: Record<string, unknown>, prefix: string, target: AllowlistedObject, depth: number) => {
    for (const [key, value] of Object.entries(source)) {
      if (!BREAKDOWN_KEY.test(key)) {
        money.fail("money_format", `${path}.?`);
        continue;
      }
      const type = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        if (depth >= 1) {
          money.fail("money_format", `${path}.${type}`);
          continue;
        }
        const child: AllowlistedObject = {};
        visit(value as Record<string, unknown>, type, child, depth + 1);
        Object.defineProperty(target, key, { value: child, enumerable: true, writable: true, configurable: true });
        continue;
      }
      if (typeof value === "string" && AMOUNT_LIKE.test(value)) Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
      const amount = money.optional(value, `${path}.${type}`);
      if (amount === null && (value === undefined || value === null)) continue;
      if (amount !== null) lines.push({ skuId, group, type, amount });
    }
  };
  visit(object, "", kept, 0);
  return kept;
}

/** `fee_tax_breakdown: { fee: {...}, tax: {...} }` and `shipping_cost_breakdown: {...}`. */
function readBreakdowns(source: Record<string, unknown>, skuId: string, money: MoneyReader, lines: TikTokFeeLine[]): AllowlistedObject {
  const kept: AllowlistedObject = {};
  const feeTax = source.fee_tax_breakdown;
  if (feeTax !== undefined && feeTax !== null) {
    const object = record(feeTax);
    if (feeTax !== object) money.fail("money_format", "fee_tax_breakdown");
    // A group other than fee/tax would be money nobody reads: refused loudly, never dropped.
    for (const key of Object.keys(object)) if (key !== "fee" && key !== "tax") money.fail("money_format", `fee_tax_breakdown.${BREAKDOWN_KEY.test(key) ? key : "?"}`);
    const fee = readBreakdown(object.fee, "fee", skuId, money, "fee_tax_breakdown.fee", lines);
    const tax = readBreakdown(object.tax, "tax", skuId, money, "fee_tax_breakdown.tax", lines);
    const both: AllowlistedObject = {};
    if (fee) both.fee = fee;
    if (tax) both.tax = tax;
    kept.fee_tax_breakdown = both;
  }
  const shipping = readBreakdown(source.shipping_cost_breakdown, "shipping", skuId, money, "shipping_cost_breakdown", lines);
  if (shipping) kept.shipping_cost_breakdown = shipping;
  return kept;
}

function withBreakdowns(payload: AllowlistedObject, breakdowns: AllowlistedObject): AllowlistedObject {
  return storable({ ...payload, ...breakdowns }) as AllowlistedObject;
}

// ---- Statements -------------------------------------------------------------------------------

/** Plan §3.5, §6: ids, times, statuses and amounts only. */
export const TIKTOK_STATEMENT_ALLOWLIST: AllowlistSpec = {
  id: true,
  statement_time: true,
  currency: true,
  settlement_amount: true,
  revenue_amount: true,
  fee_amount: true,
  adjustment_amount: true,
  shipping_cost_amount: true,
  net_sales_amount: true,
  payment_status: true,
  payment_id: true,
};

export interface TikTokStatementAmounts {
  settlement: number | null;
  revenue: number | null;
  fee: number | null;
  adjustment: number | null;
  shippingCost: number | null;
}

export interface TikTokStatementProjection {
  statementId: string;
  statementTime: Date;
  currency: string | null;
  amounts: TikTokStatementAmounts;
  problem: TikTokFinanceProblem | null;
  problemField: string | null;
  /** Raw, e.g. `PAID`, `PROCESSING`; null when absent. */
  paymentStatus: string | null;
  paymentId: string | null;
  payload: AllowlistedObject;
  contentSha256: string;
}

export type ProjectResult<T> = { ok: true; value: T } | { ok: false; id: string | null };

export function projectTikTokStatement(raw: unknown): ProjectResult<TikTokStatementProjection> {
  const source = record(raw);
  const statementId = isId(source.id) ? source.id : null;
  const statementTime = secondsToDate(source.statement_time);
  if (!statementId || !statementTime) return { ok: false, id: statementId };
  const money = new MoneyReader();
  const currency = money.currency(source.currency, "currency", true);
  const amounts: TikTokStatementAmounts = {
    settlement: money.required(source.settlement_amount, "settlement_amount"),
    revenue: money.optional(source.revenue_amount, "revenue_amount"),
    fee: money.optional(source.fee_amount, "fee_amount"),
    adjustment: money.optional(source.adjustment_amount, "adjustment_amount"),
    shippingCost: money.optional(source.shipping_cost_amount, "shipping_cost_amount"),
  };
  const payload = storable(allowlisted(source, TIKTOK_STATEMENT_ALLOWLIST)) as AllowlistedObject;
  return {
    ok: true,
    value: {
      statementId,
      statementTime,
      currency,
      amounts,
      problem: money.problem,
      problemField: money.field,
      paymentStatus: code(source.payment_status),
      paymentId: isId(source.payment_id) ? source.payment_id : null,
      payload,
      contentSha256: sha256(payload),
    },
  };
}

// ---- Statement transactions (by statement) ------------------------------------------------------

export const TIKTOK_STATEMENT_TRANSACTION_ALLOWLIST: AllowlistSpec = {
  id: true,
  type: true,
  order_id: true,
  order_create_time: true,
  adjustment_id: true,
  adjustment_order_id: true,
  associated_order_id: true,
  currency: true,
  settlement_amount: true,
  revenue_amount: true,
  fee_tax_amount: true,
  shipping_cost_amount: true,
  adjustment_amount: true,
};

export interface TikTokTransactionAmounts {
  settlement: number | null;
  revenue: number | null;
  feeTax: number | null;
  shippingCost: number | null;
  adjustment: number | null;
}

export interface TikTokStatementTransactionProjection {
  transactionId: string;
  statementId: string;
  /** TikTok's type as received (`ORDER`, `REFUND`, an adjustment type, ...). */
  type: string;
  tiktokOrderId: string | null;
  amounts: TikTokTransactionAmounts;
  problem: TikTokFinanceProblem | null;
  problemField: string | null;
  /** The transaction-level breakdown (kept for the audit trail; the fee grain comes from Get
   * Transactions by Order). */
  fees: TikTokFeeLine[];
  payload: AllowlistedObject;
  contentSha256: string;
}

function transactionAmounts(source: Record<string, unknown>, money: MoneyReader, prefix = ""): TikTokTransactionAmounts {
  return {
    settlement: money.required(source[`${prefix}settlement_amount`], `${prefix}settlement_amount`),
    revenue: money.optional(source[`${prefix}revenue_amount`], `${prefix}revenue_amount`),
    feeTax: money.optional(source[`${prefix}fee_tax_amount`], `${prefix}fee_tax_amount`),
    shippingCost: money.optional(source[`${prefix}shipping_cost_amount`], `${prefix}shipping_cost_amount`),
    adjustment: money.optional(source[`${prefix}adjustment_amount`], `${prefix}adjustment_amount`),
  };
}

function orderIdOf(source: Record<string, unknown>): string | null {
  for (const key of ["order_id", "adjustment_order_id", "associated_order_id"]) {
    if (isTikTokOrderId(source[key])) return source[key] as string;
  }
  return null;
}

export function projectTikTokStatementTransaction(statementId: string, raw: unknown): ProjectResult<TikTokStatementTransactionProjection> {
  const source = record(raw);
  const transactionId = isId(source.id) ? source.id : null;
  const type = code(source.type);
  if (!transactionId || !type) return { ok: false, id: transactionId };
  if (TIKTOK_ORDER_TRANSACTION_TYPES.has(type) && orderIdOf(source) === null) return { ok: false, id: transactionId };
  const money = new MoneyReader();
  money.currency(source.currency, "currency", false);
  const amounts = transactionAmounts(source, money);
  const fees: TikTokFeeLine[] = [];
  const breakdowns = readBreakdowns(source, "", money, fees);
  const payload = withBreakdowns(allowlisted(source, TIKTOK_STATEMENT_TRANSACTION_ALLOWLIST), breakdowns);
  return {
    ok: true,
    value: { transactionId, statementId, type, tiktokOrderId: orderIdOf(source), amounts, problem: money.problem, problemField: money.field, fees, payload, contentSha256: sha256(payload) },
  };
}

// ---- Transactions by order (SKU-level fees) ------------------------------------------------------

export interface TikTokOrderTransaction {
  transactionId: string;
  statementId: string | null;
  /** SKU-level lines when TikTok split the transaction per SKU, else its order-level lines. */
  fees: TikTokFeeLine[];
  problem: TikTokFinanceProblem | null;
  problemField: string | null;
}

export interface TikTokOrderTransactionsProjection {
  tiktokOrderId: string;
  transactions: TikTokOrderTransaction[];
  /** Entries without a usable id. */
  invalid: number;
  payload: AllowlistedObject;
  contentSha256: string;
}

// No product or SKU name: free text the finance side does not need (the SKU id is enough).
const SKU_ALLOWLIST: AllowlistSpec = { sku_id: true, quantity: true, settlement_amount: true, revenue_amount: true, fee_tax_amount: true, shipping_cost_amount: true };
const ORDER_TRANSACTION_ALLOWLIST: AllowlistSpec = { id: true, statement_id: true, type: true, currency: true, settlement_amount: true, revenue_amount: true, fee_tax_amount: true, shipping_cost_amount: true };

/** Two entries for the same SKU and fee type (TikTok listing a SKU twice) are summed: the stored grain
 * is one row per SKU × type, so keeping them apart would make the later overwrite the earlier. */
function mergeLines(lines: readonly TikTokFeeLine[]): TikTokFeeLine[] {
  const merged = new Map<string, TikTokFeeLine>();
  for (const item of lines) {
    const key = `${item.skuId}\u001f${item.group}\u001f${item.type}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, amount: existing.amount + item.amount } : { ...item });
  }
  return [...merged.values()];
}

export function projectTikTokOrderTransactions(tiktokOrderId: string, data: unknown): TikTokOrderTransactionsProjection {
  const source = record(data);
  const list = Array.isArray(source.statement_transactions) ? source.statement_transactions : [];
  const transactions: TikTokOrderTransaction[] = [];
  const kept: AllowlistedObject[] = [];
  let invalid = 0;
  for (const raw of list) {
    const entry = record(raw);
    if (!isId(entry.id)) {
      invalid += 1;
      continue;
    }
    const money = new MoneyReader();
    money.currency(entry.currency, "currency", false);
    const fees: TikTokFeeLine[] = [];
    const skus = Array.isArray(entry.sku_statement_transactions) ? entry.sku_statement_transactions : [];
    const keptSkus: AllowlistedObject[] = [];
    if (skus.length > 0) {
      for (const rawSku of skus) {
        const sku = record(rawSku);
        const skuId = isId(sku.sku_id) ? sku.sku_id : null;
        if (!skuId) {
          money.fail("money_format", "sku_statement_transactions.sku_id");
          continue;
        }
        const skuBreakdowns = readBreakdowns(sku, skuId, money, fees);
        keptSkus.push({ ...allowlisted(sku, SKU_ALLOWLIST), ...skuBreakdowns });
      }
    }
    const orderBreakdowns = readBreakdowns(entry, "", money, skus.length > 0 ? [] : fees);
    const keptEntry: AllowlistedObject = { ...allowlisted(entry, ORDER_TRANSACTION_ALLOWLIST), ...orderBreakdowns };
    if (keptSkus.length > 0) keptEntry.sku_statement_transactions = keptSkus;
    kept.push(keptEntry);
    transactions.push({ transactionId: entry.id as string, statementId: isId(entry.statement_id) ? entry.statement_id : null, fees: mergeLines(fees), problem: money.problem, problemField: money.field });
  }
  const payload = storable({ order_id: tiktokOrderId, statement_transactions: kept }) as AllowlistedObject;
  return { tiktokOrderId, transactions, invalid, payload, contentSha256: sha256(payload) };
}

// ---- Unsettled transactions (estimates) --------------------------------------------------------

export const TIKTOK_UNSETTLED_ALLOWLIST: AllowlistSpec = {
  id: true,
  type: true,
  order_id: true,
  order_create_time: true,
  adjustment_id: true,
  adjustment_order_id: true,
  associated_order_id: true,
  currency: true,
  status: true,
  est_settlement_amount: true,
  est_revenue_amount: true,
  est_fee_tax_amount: true,
  est_shipping_cost_amount: true,
  est_adjustment_amount: true,
};

export interface TikTokUnsettledProjection {
  transactionId: string;
  type: string;
  tiktokOrderId: string | null;
  amounts: TikTokTransactionAmounts;
  problem: TikTokFinanceProblem | null;
  problemField: string | null;
  /** Order-level estimated fee lines (`skuId` ""). */
  fees: TikTokFeeLine[];
  payload: AllowlistedObject;
  contentSha256: string;
}

export function projectTikTokUnsettledTransaction(raw: unknown): ProjectResult<TikTokUnsettledProjection> {
  const source = record(raw);
  const transactionId = isId(source.id) ? source.id : null;
  const type = code(source.type);
  if (!transactionId || !type) return { ok: false, id: transactionId };
  if (TIKTOK_ORDER_TRANSACTION_TYPES.has(type) && orderIdOf(source) === null) return { ok: false, id: transactionId };
  const money = new MoneyReader();
  money.currency(source.currency, "currency", false);
  const amounts = transactionAmounts(source, money, "est_");
  const fees: TikTokFeeLine[] = [];
  const breakdowns = readBreakdowns(source, "", money, fees);
  const payload = withBreakdowns(allowlisted(source, TIKTOK_UNSETTLED_ALLOWLIST), breakdowns);
  return { ok: true, value: { transactionId, type, tiktokOrderId: orderIdOf(source), amounts, problem: money.problem, problemField: money.field, fees, payload, contentSha256: sha256(payload) } };
}

// ---- Payments (payouts to the bank) ------------------------------------------------------------

/** No bank account number: only its last four digits are kept, on the row (plan §3.5). */
export const TIKTOK_PAYMENT_ALLOWLIST: AllowlistSpec = {
  id: true,
  create_time: true,
  paid_time: true,
  status: true,
  amount: { value: true, currency: true },
  settlement_amount: { value: true, currency: true },
  reserve_amount: { value: true, currency: true },
};

export interface TikTokPaymentProjection {
  paymentId: string;
  createTime: Date | null;
  paidTime: Date | null;
  status: string | null;
  currency: string | null;
  amount: number | null;
  problem: TikTokFinanceProblem | null;
  problemField: string | null;
  bankAccountLast4: string | null;
  payload: AllowlistedObject;
  contentSha256: string;
}

export function projectTikTokPayment(raw: unknown): ProjectResult<TikTokPaymentProjection> {
  const source = record(raw);
  const paymentId = isId(source.id) ? source.id : null;
  if (!paymentId) return { ok: false, id: null };
  const money = new MoneyReader();
  const amountObject = record(source.amount);
  const currency = money.currency(amountObject.currency, "amount.currency", true);
  const amount = money.required(amountObject.value, "amount.value");
  const bank = typeof source.bank_account === "string" ? /([0-9]{4})$/.exec(source.bank_account.trim()) : null;
  const payload = storable(allowlisted(source, TIKTOK_PAYMENT_ALLOWLIST)) as AllowlistedObject;
  return {
    ok: true,
    value: {
      paymentId,
      createTime: secondsToDate(source.create_time),
      paidTime: secondsToDate(source.paid_time),
      status: code(source.status),
      currency,
      amount,
      problem: money.problem,
      problemField: money.field,
      bankAccountLast4: bank ? bank[1]! : null,
      payload,
      contentSha256: sha256(payload),
    },
  };
}

// ---- Calls ----------------------------------------------------------------------------------

interface ShopCall {
  accessToken: Secret;
  shopCipher: string;
  deadline: number;
  onAuthError?: () => Promise<Secret>;
}

export interface TikTokFinancePage<T> {
  records: T[];
  /** Entries that could not be identified (no id or type): the caller holds its cursor on them. */
  invalid: number;
  invalidIds: string[];
  nextPageToken: string | null;
}

const pageSchema = z.object({ next_page_token: z.string().max(4096).optional() }).passthrough();

async function listPage<T>(
  client: TikTokClient,
  call: ShopCall & { pageToken?: string | null; pageSize?: number },
  path: string,
  listKey: string,
  query: Record<string, string | number>,
  project: (raw: unknown) => ProjectResult<T>,
): Promise<TikTokFinancePage<T>> {
  const pageSize = call.pageSize ?? FINANCE_MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > FINANCE_MAX_PAGE_SIZE) throw new Error(`tiktok finance: page_size must be 1-${FINANCE_MAX_PAGE_SIZE}`);
  const data = (await client.request({
    method: "GET",
    path,
    query: { ...query, page_size: pageSize, ...(call.pageToken ? { page_token: call.pageToken } : {}) },
    accessToken: call.accessToken,
    shopCipher: call.shopCipher,
    schema: pageSchema as z.ZodType<Record<string, unknown>>,
    deadline: call.deadline,
    onAuthError: call.onAuthError,
  })) as { next_page_token?: string } & Record<string, unknown>;
  const list = data[listKey];
  // A list under another key than assumed (T0 checks the names) is refused loudly, never read as
  // "nothing", which would let a cursor pass every record of the window.
  if (list === undefined && Object.values(data).some(Array.isArray)) throw new TikTokApiError({ kind: "invalid_response", path, httpStatus: null, code: null, requestId: null });
  if (list !== undefined && !Array.isArray(list)) throw new TikTokApiError({ kind: "invalid_response", path, httpStatus: null, code: null, requestId: null });
  const page: TikTokFinancePage<T> = { records: [], invalid: 0, invalidIds: [], nextPageToken: null };
  for (const raw of (list as unknown[] | undefined) ?? []) {
    const projected = project(raw);
    if (projected.ok) page.records.push(projected.value);
    else {
      page.invalid += 1;
      if (projected.id) page.invalidIds.push(projected.id);
    }
  }
  const token = data.next_page_token?.trim() ?? "";
  page.nextPageToken = token === "" ? null : token;
  return page;
}

function window(ge: Date, lt: Date, name: string): { ge: number; lt: number } {
  const from = tiktokSeconds(ge);
  const to = tiktokSeconds(lt);
  if (!(from < to)) throw new Error(`tiktok finance: ${name}_ge must be before ${name}_lt`);
  return { ge: from, lt: to };
}

export type FinanceWindowCall = ShopCall & { from: Date; to: Date; pageToken?: string | null; pageSize?: number };

/** Get Statements by `statement_time`, oldest first. */
export async function getTikTokStatements(client: TikTokClient, input: FinanceWindowCall): Promise<TikTokFinancePage<TikTokStatementProjection>> {
  const { ge, lt } = window(input.from, input.to, "statement_time");
  return listPage(client, input, TIKTOK_ENDPOINTS.statements, "statements", { statement_time_ge: ge, statement_time_lt: lt, sort_field: "statement_time", sort_order: "ASC" }, projectTikTokStatement);
}

/** Get Transactions by Statement, every type (orders, refunds, adjustments). */
export async function getTikTokStatementTransactions(
  client: TikTokClient,
  statementId: string,
  input: ShopCall & { pageToken?: string | null; pageSize?: number },
): Promise<TikTokFinancePage<TikTokStatementTransactionProjection>> {
  if (!isId(statementId)) throw new Error("getTikTokStatementTransactions: invalid statement id");
  return listPage(client, input, TIKTOK_ENDPOINTS.statementTransactions(statementId), "statement_transactions", { sort_field: "order_create_time", sort_order: "ASC" }, (raw) =>
    projectTikTokStatementTransaction(statementId, raw),
  );
}

/** Get Transactions by Order: the SKU-level fee grain of one order's settled transactions. */
export async function getTikTokOrderTransactions(client: TikTokClient, tiktokOrderId: string, input: ShopCall): Promise<TikTokOrderTransactionsProjection> {
  if (!isTikTokOrderId(tiktokOrderId)) throw new Error("getTikTokOrderTransactions: invalid order id");
  const path = TIKTOK_ENDPOINTS.orderStatementTransactions(tiktokOrderId);
  const data = await client.request({
    method: "GET",
    path,
    accessToken: input.accessToken,
    shopCipher: input.shopCipher,
    schema: z.object({ statement_transactions: z.array(z.unknown()).max(1000).optional() }).passthrough() as z.ZodType<Record<string, unknown>>,
    deadline: input.deadline,
    onAuthError: input.onAuthError,
  });
  if (data.statement_transactions === undefined && Object.values(data).some(Array.isArray)) throw new TikTokApiError({ kind: "invalid_response", path, httpStatus: null, code: null, requestId: null });
  return projectTikTokOrderTransactions(tiktokOrderId, data);
}

/** Get Unsettled Transactions (estimates) by order creation time, oldest first. */
export async function getTikTokUnsettledTransactions(client: TikTokClient, input: FinanceWindowCall): Promise<TikTokFinancePage<TikTokUnsettledProjection>> {
  const { ge, lt } = window(input.from, input.to, "search_time");
  return listPage(client, input, TIKTOK_ENDPOINTS.unsettledTransactions, "transactions", { search_time_ge: ge, search_time_lt: lt, sort_field: "order_create_time", sort_order: "ASC" }, projectTikTokUnsettledTransaction);
}

/** Get Payments (payouts to the bank) by `create_time`, oldest first. */
export async function getTikTokPayments(client: TikTokClient, input: FinanceWindowCall): Promise<TikTokFinancePage<TikTokPaymentProjection>> {
  const { ge, lt } = window(input.from, input.to, "create_time");
  return listPage(client, input, TIKTOK_ENDPOINTS.payments, "payments", { create_time_ge: ge, create_time_lt: lt, sort_field: "create_time", sort_order: "ASC" }, projectTikTokPayment);
}

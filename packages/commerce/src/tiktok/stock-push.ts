import "server-only";
import { sql } from "drizzle-orm";
import { TikTokApiError, TIKTOK_ENDPOINTS, updateTikTokInventory, type Secret, type TikTokClient, type TikTokInventorySkuResult } from "@ammari/tiktok-shop";
import { writeAuditLog, type Database } from "../db";
import { loadTikTokTargetInputs, queueAllMappedTikTokStock, tiktokTargetFor } from "./stock-sync";
import {
  TIKTOK_STOCK_HOLD_CODES,
  TIKTOK_STOCK_LISTING_MAX_AGE_MS,
  planTikTokProductPush,
  tiktokStockPushBackoffMs,
  tiktokStockPushErrorAction,
  type TikTokPushCandidate,
  type TikTokPushDecision,
} from "./stock-push-rules";

// TikTok stock sync S2, the push (docs/plans/tiktok-stock-sync.md §7). The database triggers of
// migration 0065 mark a variant dirty (tiktok_stock_outbox) in the same transaction as every change that
// can move its target; this module drains those marks:
//
//   1. the gate: an active connection, the stock switch on (and therefore "Mulai terapkan pesanan", R1),
//      `seller.product.write` granted, and a COMPLETE listing read pass in the last 2 hours with no pass
//      failing since (R11). Closed → nothing is sent and the marks wait;
//   2. due variants (no retry pending, or a mark newer than the last failure), grouped by the TikTok
//      product of the listings their ACTIVE mapping names (re-resolved now, never the stored variant);
//   3. per product, under `pg_advisory_xact_lock('tiktok-stock:<connection>:<product>')`: the listing
//      rows re-read, R7 recounted from the tables, the target recomputed from the ledger, holds and held
//      TikTok orders (never a queued value), planTikTokProductPush, then ONE Update Inventory call with
//      every SKU to send (own warehouse only, INCREMENTAL), and the results written to the listing rows
//      before the lock is released, so a second pusher of the same product finds them unchanged;
//   4. per variant: pushed, unchanged or held → its marks up to the id read are deleted (a mark written
//      meanwhile stays); a retryable failure → backoff (tiktok_stock_push_retries), marks kept.
//
// Logs nothing: the callers log the counts (ids and codes only, never a token, a URL or a body).

export const TIKTOK_STOCK_PUSH_SCOPE = "seller.product.write";
/** The full reconciliation (every mapped variant re-queued; the diff skips what is equal). */
export const TIKTOK_STOCK_RECONCILE_EVERY_MS = 60 * 60_000;
/** Variants one drain looks at. */
export const TIKTOK_STOCK_DRAIN_BATCH = 200;
/** One Update Inventory call (its retries included) never takes longer than this. */
export const TIKTOK_STOCK_PUSH_CALL_MAX_MS = 30_000;
/** A pusher waits this long for another one of the same product, then leaves it to the next drain. */
const PUSH_LOCK_TIMEOUT = "45s";
const PROBLEM_SAMPLE = 20;

export interface TikTokStockPushCall {
  accessToken: Secret;
  shopCipher: string;
  deadline: number;
  onAuthError?: () => Promise<Secret>;
}

export interface TikTokStockPushContext {
  db: Database;
  api: TikTokClient;
  connectionId: string;
  /** Credentials for one call (the sync session's, with its auth refresher). */
  call: (path: string) => TikTokStockPushCall;
  clock: () => Date;
  /** Epoch ms: no product is started after it. */
  deadline: number;
}

export type TikTokStockPushSkip = "not_connected" | "reauth_required" | "switch_off" | "no_scope" | "listings_never_read" | "listings_stale" | "listings_failing";

export interface TikTokStockPushCounts {
  skipped: TikTokStockPushSkip | null;
  /** Due variants this drain looked at. */
  variants: number;
  products: number;
  calls: number;
  /** SKUs TikTok accepted. */
  pushed: number;
  /** SKUs whose target equals what TikTok has (no call needed). */
  unchanged: number;
  /** SKUs held by the rules (unmapped, a listing hold, R7, stale, ...). */
  held: number;
  /** SKUs TikTok refused with a §0 code: held, never retried in a loop. */
  refused: number;
  /** SKUs whose push failed for a retryable reason (rate limit, outage, network, unknown code). */
  failed: number;
  /** Products another pusher held past the lock timeout (left for the next drain). */
  busy: number;
  /** Products that failed for a database or programming error (left for the next drain). */
  errors: number;
  /** The drain ran out of its budget before every product. */
  budgetExhausted: boolean;
  /** Cron only: hold expiries queued, full reconciliation, marks purged while the switch is off. */
  expiredHolds: number;
  reconciled: number;
  purged: number;
  /** Marks folded into one per variant (cron upkeep). */
  compacted: number;
  /** After the drain: variants that failed 3+ times in a row (the route answers 500 while any exist, so
   * a long outage keeps the cron's ALERT going), and SKUs TikTok refused that still wait for a person
   * or a re-read (a "needs a look" line on every run while any exist). */
  stuckRetries: number;
  refusedSkus: number;
  /** Up to 20 product or SKU ids with a code. Never a value or a message. */
  problems: { id: string; code: string }[];
}

export function emptyTikTokStockPushCounts(): TikTokStockPushCounts {
  return { skipped: null, variants: 0, products: 0, calls: 0, pushed: 0, unchanged: 0, held: 0, refused: 0, failed: 0, busy: 0, errors: 0, budgetExhausted: false, expiredHolds: 0, reconciled: 0, purged: 0, compacted: 0, stuckRetries: 0, refusedSkus: 0, problems: [] };
}

function noteProblem(counts: TikTokStockPushCounts, id: string, code: string): void {
  if (counts.problems.length < PROBLEM_SAMPLE) counts.problems.push({ id, code: code.slice(0, 64) });
}

/** Postgres SQLSTATE or the error's class name: never its message. */
function errorCode(error: unknown): string {
  // Drizzle wraps a query failure (DrizzleQueryError): the SQLSTATE is on `cause`.
  const source = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const code = typeof source === "object" && source !== null ? (source as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `sqlstate:${code}`;
  return error instanceof Error ? error.name.slice(0, 40) : "unknown";
}

/** What a failed call is stored as: TikTok's numeric code for a refused call, else the error kind. */
function apiErrorCode(error: TikTokApiError): string {
  return error.kind === "api" && error.code !== null ? String(error.code) : error.kind;
}

const toDate = (value: string | Date | null): Date | null => (value === null ? null : new Date(value));

// ---- The gate ---------------------------------------------------------------------------------------

export type TikTokStockPushGate = { ok: true; connectionId: string } | { ok: false; reason: TikTokStockPushSkip; connectionId: string | null };

/** Whether anything may be pushed now (the switch, R1, the scope, R11). */
export async function tiktokStockPushGate(db: Database): Promise<TikTokStockPushGate> {
  const [row] = await db.execute<{
    id: string;
    stock_sync_enabled: boolean;
    orders_apply_enabled: boolean;
    granted_scopes: string[];
    last_ok_at: string | Date | null;
    last_error_code: string | null;
    stale: boolean | null;
  }>(sql`
    select c.id, c.stock_sync_enabled, c.orders_apply_enabled, c.granted_scopes, cur.last_ok_at, cur.last_error_code,
           cur.last_ok_at < now() - make_interval(secs => ${TIKTOK_STOCK_LISTING_MAX_AGE_MS / 1000}) as stale
    from tiktok_shop_connections c left join tiktok_sync_cursors cur on cur.resource = 'products'
    where c.status = 'active'
    order by c.updated_at desc
    limit 1
  `);
  if (!row) return { ok: false, reason: "not_connected", connectionId: null };
  const connectionId = row.id;
  if (!row.stock_sync_enabled || !row.orders_apply_enabled) return { ok: false, reason: "switch_off", connectionId };
  if (!row.granted_scopes.includes(TIKTOK_STOCK_PUSH_SCOPE)) return { ok: false, reason: "no_scope", connectionId };
  if (row.last_ok_at === null) return { ok: false, reason: "listings_never_read", connectionId };
  if (row.stale) return { ok: false, reason: "listings_stale", connectionId };
  // A pass that failed (or stopped) since the last complete one: listings may be wrong. Wait for a good one.
  if (row.last_error_code !== null) return { ok: false, reason: "listings_failing", connectionId };
  return { ok: true, connectionId };
}

// ---- Cron-only upkeep -------------------------------------------------------------------------------

/** The cron's housekeeping before a drain (never in an after() push):
 *  - switch off → every mark and retry is dropped (turning it on queues every mapped variant again);
 *  - hold expiries: a checkout hold that expired writes nothing, so variants whose active hold's
 *    `expires_at` fell in (last scan, now] are queued (the target goes back up, decision 1);
 *  - the full reconciliation, hourly and on the first run after the switch went on: every mapped
 *    variant re-queued (TikTok drift, a stock write that raced the switch). */
export async function prepareTikTokStockOutbox(db: Database, counts: TikTokStockPushCounts): Promise<void> {
  await db.transaction(async (tx) => {
    const [connection] = await tx.execute<{ id: string; stock_sync_changed_at: string | Date | null }>(sql`
      select id, stock_sync_changed_at from tiktok_shop_connections where stock_sync_enabled order by updated_at desc limit 1
    `);
    if (!connection) {
      const purged = await tx.execute(sql`delete from tiktok_stock_outbox returning id`);
      await tx.execute(sql`delete from tiktok_stock_push_retries`);
      counts.purged = purged.length;
      return;
    }
    // One mark per variant is enough (a mark only says "recompute"): fold the rest, so a long closed gate
    // (listings failing, no scope) never grows the table without bound. Only visible rows are touched; a
    // pusher that read a folded id simply finds it gone, and the kept (newest) one is pushed later.
    const folded = await tx.execute(sql`
      delete from tiktok_stock_outbox o using (select variant_sku, max(id) as keep from tiktok_stock_outbox group by variant_sku having count(*) > 1) k
      where o.variant_sku = k.variant_sku and o.id < k.keep
      returning o.id
    `);
    counts.compacted = folded.length;
    // Same transaction as the watermark, so a crash never skips or double-queues a window.
    const [cursor] = await tx.execute<{ window_end: string | Date | null }>(sql`select window_end from tiktok_sync_cursors where resource = 'stock_push' for update`);
    const expired = await tx.execute<{ variant_sku: string }>(sql`
      insert into tiktok_stock_outbox (variant_sku, source)
      select distinct sku, 'hold_expiry' from stock_reservations
      where status = 'active' and expires_at <= now() and expires_at > coalesce(${cursor?.window_end ? new Date(cursor.window_end).toISOString() : null}::timestamptz, now() - interval '1 day')
      returning variant_sku
    `);
    counts.expiredHolds = expired.length;
    await tx.execute(sql`
      insert into tiktok_sync_cursors (resource, window_end) values ('stock_push', now())
      on conflict (resource) do update set window_end = excluded.window_end, updated_at = now()
    `);

    // Due hourly, and on the first run after the switch went on (the cursor's window_end remembers which
    // switch-on it covered: no comparison between the app's clock and the database's).
    const changedAt = connection.stock_sync_changed_at ? new Date(connection.stock_sync_changed_at).toISOString() : null;
    const [reconcile] = await tx.execute<{ due: boolean }>(sql`
      select coalesce(
        (select last_ok_at < now() - make_interval(secs => ${TIKTOK_STOCK_RECONCILE_EVERY_MS / 1000}) or window_end is distinct from ${changedAt}::timestamptz
         from tiktok_sync_cursors where resource = 'stock_reconcile'),
        true) as due
    `);
    if (reconcile?.due) {
      counts.reconciled = await queueAllMappedTikTokStock(tx, connection.id, "reconcile");
      await tx.execute(sql`
        insert into tiktok_sync_cursors (resource, last_ok_at, last_run_at, window_end) values ('stock_reconcile', now(), now(), ${changedAt}::timestamptz)
        on conflict (resource) do update set last_ok_at = excluded.last_ok_at, last_run_at = excluded.last_run_at, window_end = excluded.window_end, updated_at = now()
      `);
    }
  });
}

/** After a COMPLETE listing read pass (sync.ts), only while the switch is on, the variants of listings this
 * pass saw that need a fresh decision now: TikTok shows another quantity than the one last pushed after
 * that push (a Seller Center edit, a TikTok sale not applied yet: Ammari overwrites, decision 3); a
 * pushable listing never pushed yet (a hold that cleared, a new listing); and one whose re-read refusal
 * (status, SKU, warehouse) this read now answers. The push's diff skips whatever is already equal. */
export async function queueTikTokListingDrift(db: Database, input: { connectionId: string; passStart: Date }): Promise<number> {
  const rows = await db.execute<{ variant_sku: string }>(sql`
    insert into tiktok_stock_outbox (variant_sku, source)
    select distinct m.variant_sku, 'listing'
    from tiktok_listing_skus l join tiktok_sku_mappings m on m.tiktok_sku_id = l.tiktok_sku_id and m.is_active
    where l.connection_id = ${input.connectionId}::uuid and l.read_at = ${input.passStart.toISOString()}::timestamptz
      and (
        (l.last_pushed_at is not null and l.read_at > l.last_pushed_at and l.tiktok_quantity is distinct from l.last_pushed_quantity)
        or (l.last_pushed_at is null and l.hold_reason is null)
        or (l.last_push_error_at is not null and l.read_at > l.last_push_error_at)
      )
      and exists (select 1 from tiktok_shop_connections c where c.id = l.connection_id and c.stock_sync_enabled)
    returning variant_sku
  `);
  return rows.length;
}

// ---- The drain --------------------------------------------------------------------------------------

type ListingRow = {
  tiktok_sku_id: string;
  tiktok_product_id: string;
  variant_sku: string | null;
  mapped_variant: string | null;
  hold_reason: string | null;
  warehouse_id: string | null;
  tiktok_quantity: number | null;
  read_at: string | Date;
  last_pushed_quantity: number | null;
  last_pushed_at: string | Date | null;
  last_push_error_code: string | null;
  last_push_error_at: string | Date | null;
};

/** `ids`: the exact mark ids this outcome read (never "every id up to the highest": ids are given at
 * INSERT, not at commit, so a slower writer's lower id can commit after the read and must survive). */
type VariantOutcome = { kind: "settled"; ids: number[] } | { kind: "retry"; code: string } | { kind: "open" };

/** A retry is due when its backoff ran out, or when a NEWER change arrived and the failure is at least a
 * minute old and not a rate limit (a burst of stock changes never hammers a TikTok that is throttling). */
const RETRY_DUE_SQL = sql`(r.next_attempt_at <= now() or (o_newest > r.updated_at and r.updated_at < now() - interval '1 minute' and r.last_error_code <> 'rate_limited'))`;

const idsOf = (value: unknown): number[] => (Array.isArray(value) ? value.map((id) => Number(id)) : []);

/** Whether the drain had nothing to do because nothing is due (cheap; the after() push asks first). */
export async function tiktokStockPushDue(db: Database): Promise<boolean> {
  const [row] = await db.execute<{ due: boolean }>(sql`
    select exists (select 1 from tiktok_shop_connections where status = 'active' and stock_sync_enabled)
       and exists (
         select 1 from (select variant_sku, max(created_at) as o_newest from tiktok_stock_outbox group by variant_sku) o
         left join tiktok_stock_push_retries r on r.variant_sku = o.variant_sku
         where r.variant_sku is null or ${RETRY_DUE_SQL}
       ) as due
  `);
  return row?.due === true;
}

/** Drains due marks (see the file header). Never throws for a TikTok failure (counted); a database
 * failure on one product is counted and the others go on. */
export async function drainTikTokStockOutbox(ctx: TikTokStockPushContext, counts: TikTokStockPushCounts, options: { limit?: number } = {}): Promise<void> {
  const gate = await tiktokStockPushGate(ctx.db);
  if (!gate.ok || gate.connectionId !== ctx.connectionId) {
    counts.skipped = gate.ok ? "not_connected" : gate.reason;
    return;
  }
  const due = await ctx.db.execute<{ variant_sku: string; ids: unknown }>(sql`
    select o.variant_sku, o.ids
    from (select variant_sku, array_agg(id order by id) as ids, max(created_at) as o_newest, min(id) as first_id from tiktok_stock_outbox group by variant_sku) o
    left join tiktok_stock_push_retries r on r.variant_sku = o.variant_sku
    where r.variant_sku is null or ${RETRY_DUE_SQL}
    order by o.first_id
    limit ${options.limit ?? TIKTOK_STOCK_DRAIN_BATCH}
  `);
  counts.variants += due.length;
  if (due.length === 0) {
    await recordDrain(ctx.db, counts);
    return;
  }
  const dueUpto = new Map(due.map((row) => [row.variant_sku, idsOf(row.ids)]));
  const list = sql.join([...dueUpto.keys()].map((sku) => sql`${sku}`), sql`, `);
  // Where each variant is pushed: the listings its ACTIVE mapping names (never the stored variant_sku).
  const homes = await ctx.db.execute<{ variant_sku: string; tiktok_product_id: string }>(sql`
    select distinct m.variant_sku, l.tiktok_product_id
    from tiktok_listing_skus l join tiktok_sku_mappings m on m.tiktok_sku_id = l.tiktok_sku_id and m.is_active
    where l.connection_id = ${ctx.connectionId}::uuid and m.variant_sku in (${list})
  `);
  const productsOf = new Map<string, Set<string>>();
  const variantsOf = new Map<string, Set<string>>();
  for (const home of homes) {
    (productsOf.get(home.variant_sku) ?? productsOf.set(home.variant_sku, new Set()).get(home.variant_sku)!).add(home.tiktok_product_id);
    (variantsOf.get(home.tiktok_product_id) ?? variantsOf.set(home.tiktok_product_id, new Set()).get(home.tiktok_product_id)!).add(home.variant_sku);
  }

  // Per variant, the outcome of every product it feeds; settled only once all of them settled.
  const outcomes = new Map<string, VariantOutcome[]>();
  for (const [variant, ids] of dueUpto) if (!productsOf.has(variant)) outcomes.set(variant, [{ kind: "settled", ids }]);
  for (const [productId, variants] of [...variantsOf].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (ctx.clock().getTime() >= ctx.deadline) {
      counts.budgetExhausted = true;
      break;
    }
    counts.products += 1;
    let result: Map<string, VariantOutcome>;
    try {
      result = await pushProduct(ctx, productId, [...variants].sort(), counts);
    } catch (error) {
      const code = errorCode(error);
      noteProblem(counts, productId, code);
      // Another pusher held the product past the lock timeout: its marks wait for the next drain.
      if (code === "sqlstate:55P03") {
        counts.busy += 1;
        continue;
      }
      // Anything else backs off like a failed call, so a deterministic failure never hot-loops (and
      // never starves the batch); it stays visible (route 500, the retry row's code on the tab).
      counts.errors += 1;
      for (const variant of variants) (outcomes.get(variant) ?? outcomes.set(variant, []).get(variant)!).push({ kind: "retry", code });
      continue;
    }
    for (const [variant, outcome] of result) (outcomes.get(variant) ?? outcomes.set(variant, []).get(variant)!).push(outcome);
  }

  for (const [variant, list] of [...outcomes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fed = productsOf.get(variant)?.size ?? 0;
    const retry = list.find((outcome): outcome is { kind: "retry"; code: string } => outcome.kind === "retry");
    if (retry) {
      await ctx.db.execute(sql`
        insert into tiktok_stock_push_retries as r (variant_sku, attempts, next_attempt_at, last_error_code)
        values (${variant}, 1, now() + make_interval(secs => ${tiktokStockPushBackoffMs(1) / 1000}), ${retry.code.slice(0, 64)})
        on conflict (variant_sku) do update set
          attempts = r.attempts + 1,
          next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, least(r.attempts, 10)))::int),
          last_error_code = excluded.last_error_code
      `);
      continue;
    }
    const settled = list.filter((outcome): outcome is { kind: "settled"; ids: number[] } => outcome.kind === "settled");
    // Every product the variant feeds was decided (none busy, failed or out of budget).
    if (settled.length === 0 || (fed > 0 && settled.length < fed)) continue;
    // Only marks EVERY product's compute saw; any other mark (committed later, whatever its id) stays.
    const [first, ...rest] = settled.map((outcome) => new Set(outcome.ids));
    const ids = [...first!].filter((id) => rest.every((set) => set.has(id)));
    if (ids.length > 0) await ctx.db.execute(sql`delete from tiktok_stock_outbox where variant_sku = ${variant} and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    await ctx.db.execute(sql`delete from tiktok_stock_push_retries where variant_sku = ${variant}`);
  }
  await recordDrain(ctx.db, counts);
}

/** The `stock_push` cursor: last drain, last clean drain, its first problem code. Also counts what keeps
 * failing or waits for a person, for the route (500 / "needs a look" on every run while it lasts). */
async function recordDrain(db: Database, counts: TikTokStockPushCounts): Promise<void> {
  const [stuck] = await db.execute<{ n: number }>(sql`select count(*)::int as n from tiktok_stock_push_retries where attempts >= 3`);
  counts.stuckRetries = Number(stuck?.n ?? 0);
  const [refused] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from tiktok_listing_skus l join tiktok_shop_connections c on c.id = l.connection_id and c.status = 'active'
    where l.last_push_error_code in (${sql.join(TIKTOK_STOCK_HOLD_CODES.map((code) => sql`${code}`), sql`, `)})
  `);
  counts.refusedSkus = Number(refused?.n ?? 0);
  const clean = counts.failed === 0 && counts.errors === 0 && counts.busy === 0;
  const code = clean ? null : (counts.problems[0]?.code ?? (counts.failed > 0 ? "push_failed" : "push_busy"));
  await db.execute(sql`
    insert into tiktok_sync_cursors (resource, last_run_at, last_ok_at, last_error_code)
    values ('stock_push', now(), ${clean ? sql`now()` : sql`null`}, ${code})
    on conflict (resource) do update set
      last_run_at = excluded.last_run_at,
      last_ok_at = ${clean ? sql`excluded.last_ok_at` : sql`tiktok_sync_cursors.last_ok_at`},
      last_error_code = excluded.last_error_code,
      updated_at = now()
  `);
}

/** One product under its advisory lock (the file header, step 3). Returns each variant's outcome. */
async function pushProduct(ctx: TikTokStockPushContext, productId: string, variants: readonly string[], counts: TikTokStockPushCounts): Promise<Map<string, VariantOutcome>> {
  return ctx.db.transaction(async (tx) => {
    // lock_timeout bounds the advisory lock wait too; the lock is held across one HTTP call, so the
    // server's idle-in-transaction timeout must not end it.
    await tx.execute(sql`select set_config('lock_timeout', ${PUSH_LOCK_TIMEOUT}, true), set_config('idle_in_transaction_session_timeout', '0', true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-stock:${ctx.connectionId}:${productId}`}))`);
    const outcomes = new Map<string, VariantOutcome>();
    // The switch may have gone off while this waited: nothing is sent then.
    const gate = await tiktokStockPushGate(tx);
    if (!gate.ok || gate.connectionId !== ctx.connectionId) {
      for (const variant of variants) outcomes.set(variant, { kind: "open" });
      return outcomes;
    }
    const list = sql.join(variants.map((sku) => sql`${sku}`), sql`, `);
    // Re-read under the lock: another pusher may have handled these marks already.
    // The exact ids visible now: what this compute covers (see VariantOutcome).
    const marks = await tx.execute<{ variant_sku: string; ids: unknown }>(sql`select variant_sku, array_agg(id order by id) as ids from tiktok_stock_outbox where variant_sku in (${list}) group by variant_sku`);
    const uptoOf = new Map(marks.map((mark) => [mark.variant_sku, idsOf(mark.ids)]));
    const rows = await tx.execute<ListingRow>(sql`
      select l.tiktok_sku_id, l.tiktok_product_id, l.variant_sku, m.variant_sku as mapped_variant, l.hold_reason, l.warehouse_id, l.tiktok_quantity,
             l.read_at, l.last_pushed_quantity, l.last_pushed_at, l.last_push_error_code, l.last_push_error_at
      from tiktok_listing_skus l join tiktok_sku_mappings m on m.tiktok_sku_id = l.tiktok_sku_id and m.is_active
      where l.connection_id = ${ctx.connectionId}::uuid and l.tiktok_product_id = ${productId} and m.variant_sku in (${list})
      order by l.tiktok_sku_id
    `);
    const dirty = rows.filter((row) => row.mapped_variant !== null && uptoOf.has(row.mapped_variant));
    // A variant without marks now was pushed by someone else: settled with nothing to delete.
    for (const variant of variants) if (!uptoOf.has(variant)) outcomes.set(variant, { kind: "settled", ids: [] });
    if (dirty.length === 0) return outcomes;

    const dirtyVariants = [...new Set(dirty.map((row) => row.mapped_variant as string))];
    const dirtyList = sql.join(dirtyVariants.map((sku) => sql`${sku}`), sql`, `);
    // R7 from the tables, now: listings of the connection the active mapping sends to this variant,
    // pushable apart from R7.
    const shared = await tx.execute<{ variant_sku: string; n: number }>(sql`
      select m.variant_sku, count(*)::int as n
      from tiktok_listing_skus l join tiktok_sku_mappings m on m.tiktok_sku_id = l.tiktok_sku_id and m.is_active
      where l.connection_id = ${ctx.connectionId}::uuid and m.variant_sku in (${dirtyList})
        and (l.hold_reason is null or l.hold_reason = 'variant_on_several_listings')
      group by m.variant_sku
    `);
    const sharedOf = new Map(shared.map((row) => [row.variant_sku, Number(row.n)]));
    const inputs = await loadTikTokTargetInputs(tx, dirtyVariants);
    const candidates: TikTokPushCandidate[] = dirty.map((row) => ({
      skuId: row.tiktok_sku_id,
      mappedVariantSku: row.mapped_variant,
      listingVariantSku: row.variant_sku,
      listingHoldReason: row.hold_reason,
      warehouseId: row.warehouse_id,
      tiktokQuantity: row.tiktok_quantity === null ? null : Number(row.tiktok_quantity),
      readAt: new Date(row.read_at),
      lastPushedQuantity: row.last_pushed_quantity === null ? null : Number(row.last_pushed_quantity),
      lastPushedAt: toDate(row.last_pushed_at),
      lastPushErrorCode: row.last_push_error_code,
      lastPushErrorAt: toDate(row.last_push_error_at),
      // A row held for its own reason is not counted; 0 here (it is held anyway) never reads as "alone".
      listingsForVariant: sharedOf.get(row.mapped_variant as string) ?? 0,
      target: tiktokTargetFor(inputs, row.mapped_variant as string),
    }));
    const plan = planTikTokProductPush(candidates, inputs.now);

    let results = new Map<string, TikTokInventorySkuResult>();
    let budgetStop = false;
    if (plan.send.length > 0) {
      counts.calls += 1;
      const call = ctx.call(TIKTOK_ENDPOINTS.updateInventory(productId));
      try {
        results = await updateTikTokInventory(ctx.api, { productId, skus: plan.send, ...call, deadline: Math.min(call.deadline, ctx.clock().getTime() + TIKTOK_STOCK_PUSH_CALL_MAX_MS) });
      } catch (error) {
        if (!(error instanceof TikTokApiError)) throw error;
        // Nothing known to be written: every SKU of the call carries the call's code.
        const code = apiErrorCode(error);
        if (error.kind === "budget_exhausted") budgetStop = true;
        noteProblem(counts, productId, code);
        results = new Map(plan.send.map((entry) => [entry.skuId, { ok: false, code }]));
      }
    }

    const perVariant = new Map<string, VariantOutcome[]>();
    for (const row of dirty) {
      const variant = row.mapped_variant as string;
      const decision = plan.decisions.get(row.tiktok_sku_id) as TikTokPushDecision;
      const upto = uptoOf.get(variant) as number[];
      let outcome: VariantOutcome;
      if (decision.kind === "send") {
        const result = results.get(row.tiktok_sku_id);
        if (result?.ok) {
          counts.pushed += 1;
          await tx.execute(sql`
            update tiktok_listing_skus set last_pushed_quantity = ${decision.quantity}, last_pushed_at = now(), last_push_error_code = null, last_push_error_at = null
            where connection_id = ${ctx.connectionId}::uuid and tiktok_sku_id = ${row.tiktok_sku_id}
          `);
          outcome = { kind: "settled", ids: upto };
        } else if (budgetStop) {
          outcome = { kind: "open" };
        } else {
          const code = result && !result.ok ? result.code : "invalid_response";
          await tx.execute(sql`
            update tiktok_listing_skus set last_push_error_code = ${code.slice(0, 64)}, last_push_error_at = now()
            where connection_id = ${ctx.connectionId}::uuid and tiktok_sku_id = ${row.tiktok_sku_id}
          `);
          if (tiktokStockPushErrorAction(code).action === "hold") {
            counts.refused += 1;
            noteProblem(counts, row.tiktok_sku_id, code);
            outcome = { kind: "settled", ids: upto };
          } else {
            counts.failed += 1;
            outcome = { kind: "retry", code };
          }
        }
      } else if (decision.kind === "unchanged") {
        counts.unchanged += 1;
        // A retryable error on the row is moot now: TikTok already has the target.
        if (row.last_push_error_code !== null && tiktokStockPushErrorAction(row.last_push_error_code).action === "retry") {
          await tx.execute(sql`update tiktok_listing_skus set last_push_error_code = null, last_push_error_at = null where connection_id = ${ctx.connectionId}::uuid and tiktok_sku_id = ${row.tiktok_sku_id}`);
        }
        outcome = { kind: "settled", ids: upto };
      } else {
        counts.held += 1;
        outcome = { kind: "settled", ids: upto };
      }
      (perVariant.get(variant) ?? perVariant.set(variant, []).get(variant)!).push(outcome);
    }
    for (const [variant, list] of perVariant) {
      outcomes.set(variant, list.find((o) => o.kind === "retry") ?? list.find((o) => o.kind === "open") ?? list[0]!);
    }
    return outcomes;
  });
}

// ---- Health and "Kirim ulang" (the Sinkron stok tab) -------------------------------------------------

export interface TikTokStockPushFailedRow {
  tiktokSkuId: string;
  tiktokProductId: string;
  productTitle: string | null;
  skuLabel: string | null;
  sellerSku: string | null;
  code: string;
  at: Date;
  /** `hold`: waits for a person (Kirim ulang); `reread`: waits for the next listing read; `retry`: retried with backoff. */
  action: "hold" | "reread" | "retry";
}

export interface TikTokStockPushHealth {
  lastPushedAt: Date | null;
  /** Variants with a mark not drained yet, and the oldest mark. */
  pendingVariants: number;
  oldestPendingAt: Date | null;
  /** How long the oldest mark has waited, by the database clock (ms); null when none waits. */
  oldestPendingAgeMs: number | null;
  /** Variants waiting for a retry (backoff). */
  retrying: number;
  failed: TikTokStockPushFailedRow[];
  lastDrainAt: Date | null;
  lastCleanDrainAt: Date | null;
  lastDrainErrorCode: string | null;
}

export const TIKTOK_STOCK_HEALTH_FAILED_LIMIT = 50;

export async function getTikTokStockPushHealth(db: Database, connectionId: string | null): Promise<TikTokStockPushHealth> {
  const [pending] = await db.execute<{ n: number; oldest: string | Date | null; age_s: number | null }>(
    sql`select count(distinct variant_sku)::int as n, min(created_at) as oldest, extract(epoch from now() - min(created_at))::int as age_s from tiktok_stock_outbox`,
  );
  const [retrying] = await db.execute<{ n: number }>(sql`select count(*)::int as n from tiktok_stock_push_retries`);
  const [cursor] = await db.execute<{ last_run_at: string | Date | null; last_ok_at: string | Date | null; last_error_code: string | null }>(
    sql`select last_run_at, last_ok_at, last_error_code from tiktok_sync_cursors where resource = 'stock_push'`,
  );
  let lastPushedAt: Date | null = null;
  let failed: TikTokStockPushFailedRow[] = [];
  if (connectionId) {
    const [last] = await db.execute<{ at: string | Date | null }>(sql`select max(last_pushed_at) as at from tiktok_listing_skus where connection_id = ${connectionId}::uuid`);
    lastPushedAt = toDate(last?.at ?? null);
    const rows = await db.execute<{ tiktok_sku_id: string; tiktok_product_id: string; product_title: string | null; sku_label: string | null; seller_sku: string | null; last_push_error_code: string; last_push_error_at: string | Date }>(sql`
      select tiktok_sku_id, tiktok_product_id, product_title, sku_label, seller_sku, last_push_error_code, last_push_error_at
      from tiktok_listing_skus where connection_id = ${connectionId}::uuid and last_push_error_code is not null
      order by last_push_error_at desc, tiktok_sku_id limit ${TIKTOK_STOCK_HEALTH_FAILED_LIMIT}
    `);
    failed = rows.map((row) => {
      const action = tiktokStockPushErrorAction(row.last_push_error_code);
      return {
        tiktokSkuId: row.tiktok_sku_id,
        tiktokProductId: row.tiktok_product_id,
        productTitle: row.product_title,
        skuLabel: row.sku_label,
        sellerSku: row.seller_sku,
        code: row.last_push_error_code,
        at: new Date(row.last_push_error_at),
        action: action.action === "retry" ? "retry" : action.reread ? "reread" : "hold",
      };
    });
  }
  return {
    lastPushedAt,
    pendingVariants: Number(pending?.n ?? 0),
    oldestPendingAt: toDate(pending?.oldest ?? null),
    oldestPendingAgeMs: pending?.age_s === null || pending?.age_s === undefined ? null : Number(pending.age_s) * 1000,
    retrying: Number(retrying?.n ?? 0),
    failed,
    lastDrainAt: toDate(cursor?.last_run_at ?? null),
    lastCleanDrainAt: toDate(cursor?.last_ok_at ?? null),
    lastDrainErrorCode: cursor?.last_error_code ?? null,
  };
}

/** "Kirim ulang yang ditolak": a person fixed what TikTok refused (ended the promotion, unlinked the
 * shared inventory, ...). Clears the refusals of the current connection's listings and queues their
 * variants; the next push tries them once more. Audited. */
export async function retryRefusedTikTokStockPushes(db: Database, input: { staffUserId: string }): Promise<{ ok: true; cleared: number } | { ok: false; reason: "not_connected" }> {
  return db.transaction(async (tx) => {
    const [connection] = await tx.execute<{ id: string }>(sql`select id from tiktok_shop_connections where status = 'active' order by updated_at desc limit 1`);
    if (!connection) return { ok: false, reason: "not_connected" };
    // The CTE keeps each row's code for the audit (an UPDATE's RETURNING only sees the new values).
    const cleared = await tx.execute<{ tiktok_sku_id: string; code: string }>(sql`
      with refused as (
        select tiktok_sku_id, last_push_error_code from tiktok_listing_skus
        where connection_id = ${connection.id}::uuid and last_push_error_code is not null
        order by tiktok_sku_id
        for update
      )
      update tiktok_listing_skus l set last_push_error_code = null, last_push_error_at = null
      from refused
      where l.connection_id = ${connection.id}::uuid and l.tiktok_sku_id = refused.tiktok_sku_id
      returning l.tiktok_sku_id, refused.last_push_error_code as code
    `);
    if (cleared.length === 0) return { ok: true, cleared: 0 };
    const ids = sql.join(cleared.map((row) => sql`${row.tiktok_sku_id}`), sql`, `);
    await tx.execute(sql`
      insert into tiktok_stock_outbox (variant_sku, source)
      select distinct m.variant_sku, 'retry' from tiktok_sku_mappings m where m.is_active and m.tiktok_sku_id in (${ids})
    `);
    await tx.execute(sql`delete from tiktok_stock_push_retries where variant_sku in (select variant_sku from tiktok_sku_mappings where is_active and tiktok_sku_id in (${ids}))`);
    await writeAuditLog(tx, {
      actorStaffUserId: input.staffUserId,
      action: "tiktok_stock_push_retry",
      entityType: "tiktok_shop_connection",
      entityId: connection.id,
      after: { skus: cleared.map((row) => ({ tiktokSkuId: row.tiktok_sku_id, code: row.code })) },
    });
    return { ok: true, cleared: cleared.length };
  });
}

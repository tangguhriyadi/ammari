import type { AllowlistedObject } from "@ammari/tiktok-shop";

// TikTok stock sync, the pure rules (docs/plans/tiktok-stock-sync.md §2, §5; S1). No database, no
// TikTok, no clock of their own: the preview (S1) and the push (S2) call the same functions, so what
// the owner sees before turning the switch on is exactly what will be sent.
//
// Every rule only ever holds: an input it cannot read becomes a hold reason, never a guessed number.

/** Update Inventory accepts 0..999,999 per SKU and warehouse (owner facts, 28 Nov 2026). */
export const TIKTOK_MAX_STOCK_QUANTITY = 999_999;

/** Product statuses Update Inventory accepts (owner facts, 28 Nov 2026). Anything else is held. */
export const TIKTOK_STOCK_UPDATABLE_STATUSES: ReadonlySet<string> = new Set(["DRAFT", "PENDING", "FAILED", "ACTIVATE", "SELLER_DEACTIVATED"]);

/** Why a variant's target could not be computed (on top of the listing's own hold reasons). */
export type TikTokTargetHoldReason = "tiktok_order_unclear" | "invalid_input";

export interface TikTokCheckoutHold {
  qty: number;
  status: "active" | "consumed" | "released";
  expiresAt: Date;
}

export interface TikTokTargetInput {
  /** SUM(stock_movements.qty) for the variant. */
  physicalQty: number;
  /** The variant's checkout holds (stock_reservations); only active, unexpired ones count. */
  holds: readonly TikTokCheckoutHold[];
  /** Pieces of paid TikTok orders not applied in admin (R2), from `tiktokHeldOrderQuantities`. */
  heldTikTokQty: number;
  /** A held TikTok order touching this variant has a line whose quantity cannot be read. */
  heldTikTokUnclear?: boolean;
  /** The database clock (`now()`), the same clock every `expires_at > now()` comparison reads. */
  now: Date;
}

export type TikTokTargetResult =
  | { kind: "push"; quantity: number; breakdown: { physical: number; checkoutHolds: number; heldTikTokOrders: number } }
  | { kind: "hold"; reason: TikTokTargetHoldReason };

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** Decision 1 + R2 + R3: physical − active unexpired checkout holds − held TikTok pieces, clamped
 * to 0..999,999. No buffer (decision 2). */
export function computeTikTokTargetQuantity(input: TikTokTargetInput): TikTokTargetResult {
  if (!isWhole(input.physicalQty) || !isWhole(input.heldTikTokQty) || input.heldTikTokQty < 0 || !(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    return { kind: "hold", reason: "invalid_input" };
  }
  let checkoutHolds = 0;
  for (const hold of input.holds) {
    if (!isWhole(hold.qty) || hold.qty <= 0 || !(hold.expiresAt instanceof Date) || Number.isNaN(hold.expiresAt.getTime())) return { kind: "hold", reason: "invalid_input" };
    // The `activeReservedQtySql` rule: active and expires_at > now. Consumed pieces are a `sale` in
    // the ledger already; released ones are back on the shelf.
    if (hold.status === "active" && hold.expiresAt.getTime() > input.now.getTime()) checkoutHolds += hold.qty;
  }
  if (input.heldTikTokUnclear) return { kind: "hold", reason: "tiktok_order_unclear" };
  const raw = input.physicalQty - checkoutHolds - input.heldTikTokQty;
  const quantity = Math.min(TIKTOK_MAX_STOCK_QUANTITY, Math.max(0, raw));
  return { kind: "push", quantity, breakdown: { physical: input.physicalQty, checkoutHolds, heldTikTokOrders: input.heldTikTokQty } };
}

// ---- Held TikTok orders (R2) -----------------------------------------------------------------

export interface TikTokHeldOrderInput {
  tiktokOrderId: string;
  /** TikTok's raw status. */
  status: string;
  /** `paid_time` is set. */
  paid: boolean;
  /** `order_id` is set: the admin order took the stock through the ledger. */
  applied: boolean;
  applyState: string | null;
  /** The latest order snapshot's allowlisted payload. */
  payload: AllowlistedObject;
}

export interface TikTokHeldOrderQuantities {
  /** Variant SKU → pieces. */
  byVariant: Map<string, number>;
  /** Variants with a held line whose quantity cannot be read: their push is held. */
  unclearVariants: Set<string>;
  /** Held orders with a line no mapping attributes to a variant (shown as a warning). */
  unattributedOrders: string[];
  /** Held orders whose lines cannot be read at all (no list, an empty one, a line that is not an
   * object): which variants they take is unknown, so every push holds while there is one. */
  unreadableOrders: string[];
}

const NOT_SOLD_STATUSES = new Set(["UNPAID", "CANCELLED"]);
const SKIPPED_STATES = new Set(["skipped_unpaid", "skipped_undone"]);

/** Whether a stored TikTok order is a sale Ammari's stock has not recorded yet. */
export function isHeldTikTokSale(order: Pick<TikTokHeldOrderInput, "status" | "paid" | "applied" | "applyState">): boolean {
  return order.paid && !order.applied && !NOT_SOLD_STATUSES.has(order.status) && !(order.applyState !== null && SKIPPED_STATES.has(order.applyState));
}

function isObject(value: unknown): value is AllowlistedObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** T5's rule (apply-rules.ts): a line without `quantity` is one piece; a present one must be a
 * positive whole number. */
function lineQuantity(item: AllowlistedObject): number | null {
  if (item.quantity === undefined || item.quantity === null) return 1;
  return isWhole(item.quantity) && item.quantity > 0 ? item.quantity : null;
}

function lineSkuId(item: AllowlistedObject): string | null {
  const value = item.sku_id;
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  if (isWhole(value)) return String(value);
  return null;
}

/** R2: pieces per variant of paid TikTok orders not applied in admin, through the active mapping
 * (TikTok SKU id → variant SKU). */
export function tiktokHeldOrderQuantities(orders: readonly TikTokHeldOrderInput[], mappings: ReadonlyMap<string, string>): TikTokHeldOrderQuantities {
  const byVariant = new Map<string, number>();
  const unclearVariants = new Set<string>();
  const unattributed = new Set<string>();
  const unreadable = new Set<string>();
  for (const order of orders) {
    if (!isHeldTikTokSale(order)) continue;
    const items = Array.isArray(order.payload.line_items) ? order.payload.line_items : [];
    // A held sale always has at least one line; none (or a renamed key) is unknown, never zero pieces.
    if (items.length === 0) unreadable.add(order.tiktokOrderId);
    for (const item of items) {
      if (!isObject(item)) {
        unreadable.add(order.tiktokOrderId);
        continue;
      }
      const skuId = lineSkuId(item);
      const variant = skuId === null ? undefined : mappings.get(skuId);
      if (!variant) {
        unattributed.add(order.tiktokOrderId);
        continue;
      }
      const qty = lineQuantity(item);
      if (qty === null) {
        unclearVariants.add(variant);
        continue;
      }
      byVariant.set(variant, (byVariant.get(variant) ?? 0) + qty);
    }
  }
  return { byVariant, unclearVariants, unattributedOrders: [...unattributed].sort(), unreadableOrders: [...unreadable].sort() };
}

// ---- Listing classification (R4, R5, R10) ---------------------------------------------------

/** Warehouse ids Get Warehouse List names as Ammari's own (domestic sales) warehouses. */
export type TikTokOwnWarehouses = ReadonlySet<string>;

export type TikTokListingHoldReason = "status_not_updatable" | "warehouse_unclear" | "quantity_unreadable";

export interface TikTokListingClassification {
  holdReason: TikTokListingHoldReason | null;
  /** Ammari's one warehouse for this SKU; null when unclear. */
  warehouseId: string | null;
  /** TikTok's quantity at that warehouse; null when unclear or unreadable. */
  quantity: number | null;
}

/** One SKU of a Search Products answer. `inventory` is TikTok's raw `[{ warehouse_id, quantity }]`.
 * Every warehouse that is not Ammari's own (FBT, or one Get Warehouse List does not name) is left
 * alone; exactly one own warehouse is required (R4). The status is the product's (R5). */
export function classifyTikTokListingSku(input: { productStatus: string; inventory: unknown; ownWarehouses: TikTokOwnWarehouses }): TikTokListingClassification {
  const raw = Array.isArray(input.inventory) ? input.inventory : [];
  const entries = raw.filter(isObject);
  const own = entries.filter((entry) => typeof entry.warehouse_id === "string" && input.ownWarehouses.has(entry.warehouse_id));
  // An entry without a usable warehouse id could be a second own warehouse in another shape: unclear.
  const unreadableEntry = entries.length !== raw.length || entries.some((entry) => typeof entry.warehouse_id !== "string");
  let result: TikTokListingClassification;
  if (own.length !== 1 || unreadableEntry) result = { holdReason: "warehouse_unclear", warehouseId: null, quantity: null };
  else {
    const entry = own[0]!;
    const warehouseId = entry.warehouse_id as string;
    const quantity = entry.quantity;
    result = isWhole(quantity) && quantity >= 0 && quantity <= TIKTOK_MAX_STOCK_QUANTITY ? { holdReason: null, warehouseId, quantity } : { holdReason: "quantity_unreadable", warehouseId, quantity: null };
  }
  // The status decides first; the warehouse and quantity are still kept for the preview.
  if (!TIKTOK_STOCK_UPDATABLE_STATUSES.has(input.productStatus)) return { ...result, holdReason: "status_not_updatable" };
  return result;
}

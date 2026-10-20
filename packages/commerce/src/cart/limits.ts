// Cart limits and buyer-facing messages (docs/plans/cart-checkout.md §4.1, §4.2, decision 4).
// No server-only import and no DB: the cart UI (session 6) reads the same constants and
// messages in client components.

/** Owner decision 4: 1 to 10 per line (also `cart_items_qty_check`). */
export const CART_MAX_QTY_PER_LINE = 10;
/** Owner decision 4: at most 20 pieces per cart and per order. Spans rows, so the cart code
 * enforces it under the cart row lock, not a constraint. */
export const CART_MAX_PIECES = 20;

/** Why a cart write was refused. Never carries a stock count (plan §4.2). */
export type CartRefusal =
  | "invalid_qty"
  | "line_limit"
  | "cart_limit"
  | "not_available"
  | "sold_out"
  | "insufficient_stock"
  | "not_in_cart";

export const CART_REFUSAL_MESSAGES: Record<CartRefusal, string> = {
  invalid_qty: "Jumlah tidak valid.",
  line_limit: `Maksimal ${CART_MAX_QTY_PER_LINE} per item.`,
  cart_limit: `Maksimal ${CART_MAX_PIECES} barang per pesanan.`,
  not_available: "Produk ini tidak tersedia lagi.",
  sold_out: "Maaf, stok habis.",
  insufficient_stock: "Stok tidak cukup untuk jumlah ini",
  not_in_cart: "Barang ini sudah tidak ada di keranjang.",
};

/** A cart line's state at render (plan §4.2). `unavailable`: the product was deactivated or
 * unpublished, or the variant deactivated. `sold_out`: nothing sellable left. `insufficient`:
 * less sellable than the line's quantity. */
export type CartLineStatus = "ok" | "insufficient" | "sold_out" | "unavailable";

export const CART_LINE_STATUS_MESSAGES: Record<Exclude<CartLineStatus, "ok">, string> = {
  insufficient: "Stok tidak cukup untuk jumlah ini",
  sold_out: "Habis",
  unavailable: "Tidak tersedia lagi",
};

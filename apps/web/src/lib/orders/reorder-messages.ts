// "Pesan lagi" texts (docs/plans/cart-checkout.md §4.4, §9.1), outside the "use server" module
// (which may only export async functions). Client-safe. Never a stock count.

import { CART_MAX_PIECES, CART_MAX_QTY_PER_LINE } from "@ammari/commerce/cart-limits";

export type ReorderSkipReason = "sold_out" | "not_available" | "insufficient_stock" | "line_limit" | "cart_limit" | "invalid_qty";

export const REORDER_LINE_MESSAGES: Record<ReorderSkipReason, string> = {
  sold_out: "Habis",
  not_available: "Tidak tersedia lagi",
  insufficient_stock: "Stok tidak cukup untuk jumlah ini",
  line_limit: `Maksimal ${CART_MAX_QTY_PER_LINE} per item`,
  cart_limit: `Maksimal ${CART_MAX_PIECES} barang per pesanan`,
  invalid_qty: "Tidak bisa ditambahkan",
};

/** The order cannot be put back in the cart from here (not cancelled, paid, or not the visitor's). */
export const REORDER_UNAVAILABLE_MESSAGE = "Pesanan ini tidak bisa dipesan lagi dari sini.";

export const REORDER_ALL_ADDED = "Semua barang dari pesanan ini sudah masuk keranjang.";
export const REORDER_SOME_ADDED = "Sebagian barang sudah masuk keranjang.";
export const REORDER_NONE_ADDED = "Belum ada barang dari pesanan ini yang bisa masuk keranjang.";

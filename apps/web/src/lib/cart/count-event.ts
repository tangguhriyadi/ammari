// The header cart count and the components that change the cart live in different trees (the
// root layout's header vs. the PDP panel or a `/cart` line), so a cart write announces the new
// piece count with a window event instead of shared state. Client-safe: no server-only import.

export const CART_COUNT_EVENT = "ammari:cart-count";
export const CART_COUNT_PATH = "/api/cart/count";

export interface CartCountDetail {
  pieceCount: number;
}

/** Call after a cart action returned `ok`, with the count it returned. */
export function announceCartCount(pieceCount: number): void {
  window.dispatchEvent(new CustomEvent<CartCountDetail>(CART_COUNT_EVENT, { detail: { pieceCount } }));
}

export const CART_COUNT_REFRESH_EVENT = "ammari:cart-count-refresh";

/** Asks the header to re-read the count from the server, after an optimistic announce turned out
 * wrong (a logout that failed). */
export function requestCartCountRefresh(): void {
  window.dispatchEvent(new Event(CART_COUNT_REFRESH_EVENT));
}

export const CART_STATUS_EVENT = "ammari:cart-status";
/** The `/cart` heading, focused after a line is removed (its row unmounts). */
export const CART_HEADING_ID = "cart-heading";

/** A short sentence for the `/cart` page's screen-reader status region ("... dihapus"). */
export function announceCartStatus(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(CART_STATUS_EVENT, { detail: text }));
}

/** Shown when a cart action call itself fails (offline, a 5xx, a deploy changed the action ids),
 * as opposed to a refusal the server answered with its own message. */
export const CART_CALL_FAILED_MESSAGE = "Terjadi kesalahan. Coba lagi.";

/** Text for a screen reader that announces the same message twice in a row: alternating a
 * trailing no-break space makes the live region's content differ, so it is read again. */
export function liveRegionText(text: string, sequence: number): string {
  return sequence % 2 === 0 ? text : `${text} `;
}

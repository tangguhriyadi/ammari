// Types of the checkout quote action (./quote-actions.ts), outside it because a "use server" module
// may only export async functions. Client-safe.

/** What the checkout page shows for the picked area (plan §4.3 section 3). Never the provider's
 * area id, the weight or the courier codes. */
export interface ShippingQuoteView {
  /** e.g. "JNE Reguler". */
  label: string;
  /** The courier cost as quoted. */
  costAmount: number;
  /** What Ammari covers (at most Rp20.000). */
  subsidyAmount: number;
  /** The buyer's "Ongkir". */
  buyerAmount: number;
}

/** How section 3 reacts (plan §4.5.5): `retry` offers "Coba lagi"; `no_service` and
 * `missing_weight` point to WhatsApp; `pick_area` asks for the area again; `cart` sends the buyer
 * back to the cart; `rate_limited` waits. */
export type ShippingQuoteFailureKind = "retry" | "no_service" | "missing_weight" | "pick_area" | "cart" | "rate_limited";

export type QuoteShippingActionResult =
  | {
      ok: true;
      quote: ShippingQuoteView;
      /** The cart's current subtotal. */
      subtotal: number;
      /** cartFingerprint (./form.ts) of the cart this quote was made for. */
      cartKey: string;
    }
  | { ok: false; kind: ShippingQuoteFailureKind; message: string };

import Link from "next/link";
import type { ShippingQuoteFailureKind, ShippingQuoteView } from "@/lib/checkout/quote-types";
import { SHIPPING_PICK_AREA_MESSAGE } from "@/lib/checkout/messages";
import { ShippingCostRows } from "@/components/shipping-cost-rows";

// Section 3 "Pengiriman" (docs/plans/cart-checkout.md §4.3, §4.5.5; docs/design/storefront.md §7):
// one fixed, non-selectable row (the server picks the cheapest allowed regular service), no courier
// choice and no delivery estimate. Never names the shipping provider or a city.

export type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; quote: ShippingQuoteView }
  | { status: "error"; kind: ShippingQuoteFailureKind; message: string };

interface ShippingSectionProps {
  state: QuoteState;
  onRetry: () => void;
  /** A wa.me link for "no service" and "missing weight", or null when no number is configured. */
  whatsappHref: string | null;
  cartHref: string;
}

export function ShippingSection({ state, onRetry, whatsappHref, cartHref }: ShippingSectionProps) {
  return (
    <div data-testid="shipping-row" aria-live="polite" aria-busy={state.status === "loading" || undefined}>
      {state.status === "idle" && <p className="border border-line px-4 py-4 text-sm text-ink-muted">{SHIPPING_PICK_AREA_MESSAGE}</p>}

      {state.status === "loading" && <p className="border border-line px-4 py-4 text-sm text-ink-muted">Menghitung ongkir...</p>}

      {state.status === "ok" && (
        <div className="flex flex-col gap-3 border border-ink px-4 py-4">
          <p className="text-[15px] text-ink" data-testid="shipping-service">
            {state.quote.label}
          </p>
          {/* The subsidy in plain sight (owner, 2026-10-21): the courier cost struck through, Ammari's
              share highlighted, then what the buyer pays. */}
          <dl className="flex flex-col gap-2 text-sm text-ink">
            <ShippingCostRows
              buyerAmount={state.quote.buyerAmount}
              costAmount={state.quote.costAmount}
              subsidyAmount={state.quote.subsidyAmount}
              testIdPrefix="shipping"
              buyerTestId="shipping-buyer-amount"
            />
          </dl>
          <p className="text-xs text-ink-muted">Nomor resi dikirim lewat email setelah pesanan dikirim.</p>
        </div>
      )}

      {state.status === "error" && (
        <div className="flex flex-col items-start gap-3 border border-error-border px-4 py-4" data-testid="shipping-error">
          <p className="text-sm text-error">{state.message}</p>
          {/* Not for rate_limited: an immediate retry would only spend more of the limit. */}
          {state.kind === "retry" && (
            <button
              type="button"
              onClick={onRetry}
              className="flex min-h-11 items-center border border-ink px-4 text-xs font-medium tracking-[0.16em] text-ink uppercase"
            >
              Coba lagi
            </button>
          )}
          {(state.kind === "no_service" || state.kind === "missing_weight") && whatsappHref && (
            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center border border-ink px-4 text-xs font-medium tracking-[0.16em] text-ink uppercase"
            >
              Hubungi via WhatsApp
            </a>
          )}
          {state.kind === "cart" && (
            <Link href={cartHref} className="flex min-h-11 items-center text-xs font-medium tracking-[0.16em] text-ink uppercase underline underline-offset-4">
              Kembali ke keranjang
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

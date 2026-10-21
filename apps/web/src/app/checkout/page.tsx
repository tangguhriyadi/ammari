import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { isCartEnabled } from "@/lib/cart-flag";
import { loadCartView } from "@/lib/cart/queries";
import { listUsableVouchers } from "@/lib/checkout/queries";
import { buildImageUrl, getStoragePublicBaseUrl } from "@/lib/storage/public-url";
import { getWhatsappNumber } from "@/lib/store-settings";
import { Container } from "@/components/container";
import { CheckoutForm } from "@/components/checkout/checkout-form";

// The checkout page (docs/plans/cart-checkout.md §4.3, docs/design/storefront.md §7,
// mockup-checkout.png). force-dynamic for the same reason as /cart: with the flag off this page
// calls notFound() before reading cookies, so without it a flag-off `next build` would prerender a
// static not-found that flipping the flag at runtime could never replace. With the flag on, every
// request re-reads the session, the cart (prices, availability) and the vouchers uncached.
//
// Only display data reaches the client: line names, variants, quantities and public prices, the
// session customer's own email/phone/name and voucher amounts. No cost data and no stock numbers.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Checkout | Ammari",
  robots: { index: false, follow: false },
};

export default async function CheckoutPage() {
  if (!isCartEnabled()) notFound();

  const session = await getCustomerSession();
  const [cart, vouchers, whatsappNumber] = await Promise.all([
    loadCartView(),
    session ? listUsableVouchers(session.id) : Promise.resolve([]),
    getWhatsappNumber(),
  ]);
  const storageBaseUrl = getStoragePublicBaseUrl();

  return (
    <Container className="py-6 md:py-10">
      <h1 className="font-serif text-[30px] font-normal text-ink">Checkout</h1>
      <CheckoutForm
        // One per page load: a double submit of this page answers with the same order (plan §5).
        checkoutAttemptId={randomUUID()}
        cart={{
          lines: cart.lines.map((line) => ({
            sku: line.sku,
            name: line.productName,
            variant: `${line.colorName} · ${line.sizeLabel}`,
            qty: line.qty,
            lineTotal: line.lineTotal,
            imageUrl: line.image ? buildImageUrl(storageBaseUrl, line.image.storageKey, 400) : null,
          })),
          subtotal: cart.subtotal,
          pieceCount: cart.pieceCount,
          canCheckout: cart.canCheckout,
        }}
        customer={session ? { email: session.email, phone: session.phone, name: session.name } : null}
        vouchers={vouchers}
        whatsappNumber={whatsappNumber}
      />
    </Container>
  );
}

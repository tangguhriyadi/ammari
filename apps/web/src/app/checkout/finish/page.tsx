import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { isCartEnabled } from "@/lib/cart-flag";
import { readOrderAccessCookie } from "@/lib/checkout/order-access-cookie";
import { loadFinishOrder, type FinishOrderView } from "@/lib/checkout/queries";
import { formatPriceIdr } from "@/lib/format";
import { Container } from "@/components/container";
import { OutlineLink, PrimaryLink } from "@/components/buttons";
import { LoginPrefillLink } from "@/components/checkout/login-prefill-link";
import { PaymentStatusCheck } from "@/components/checkout/payment-status-check";
import { ReopenPaymentButton } from "@/components/checkout/reopen-payment-button";
import { ReorderButton } from "@/components/orders/reorder-button";
import { LOGIN_FOR_ORDERS_HREF } from "@/lib/auth/login-prefill";

// Where the payment page sends the buyer back (docs/plans/cart-checkout.md §4.4,
// docs/design/storefront.md §7): `/checkout/finish?order=<orderNo>`. Shown only to the buyer who
// placed the order (their session, or the checkout's order access cookie; lib/checkout/queries.ts),
// otherwise the same "log in to see it" page as an unknown order. The state comes from our own database
// only, never from the redirect itself (its order_id / transaction_status query is ignored):
// "Pembayaran berhasil" appears only once a verified notification, or the page's own server-side
// status check (PaymentStatusCheck), has marked the order paid. force-dynamic like /checkout.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status pesanan | Ammari",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const COLLECTION_HREF = "/#koleksi";

const HEADINGS: Record<FinishOrderView["state"], string> = {
  paid: "Pembayaran berhasil",
  pending: "Menunggu pembayaran",
  confirming: "Menunggu konfirmasi pembayaran",
  failed: "Pembayaran gagal atau kedaluwarsa",
  refund_pending: "Pesanan dibatalkan",
};

/** Every visit this browser cannot prove is the buyer's (an unknown order number included) gets
 * the same answer, so it never confirms that an order exists. A guest whose checkout cookie is
 * gone (another device, cleared cookies, or a repeat submit after a dropped connection, plan §5)
 * finds their way in through the email login. */
function CannotShowOrder() {
  return (
    <Container className="flex max-w-[640px] flex-col gap-6 py-8 md:py-12">
      <h1 className="font-serif text-[30px] font-normal text-ink" data-testid="finish-heading">
        Lihat pesanan
      </h1>
      <p className="text-sm text-ink-muted">
        Pesanan ini tidak bisa ditampilkan di perangkat ini. Masuk dengan email yang kamu pakai saat memesan untuk melihat pesananmu.
      </p>
      <PrimaryLink href={LOGIN_FOR_ORDERS_HREF} className="w-full">
        Masuk
      </PrimaryLink>
    </Container>
  );
}

export default async function CheckoutFinishPage({ searchParams }: { searchParams: Promise<{ order?: string | string[] }> }) {
  if (!isCartEnabled()) notFound();

  const { order } = await searchParams;
  const orderNo = typeof order === "string" ? order.slice(0, 40) : "";
  const [session, accessToken] = await Promise.all([getCustomerSession(), readOrderAccessCookie()]);
  const view = orderNo ? await loadFinishOrder({ orderNo, sessionCustomerId: session?.id ?? null, accessTokens: [accessToken] }) : null;
  if (!view) return <CannotShowOrder />;

  return (
    <Container className="flex max-w-[640px] flex-col gap-8 py-8 md:py-12">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-ink-muted">Pesanan {view.orderNo}</p>
        <h1 className="font-serif text-[30px] font-normal text-ink" data-testid="finish-heading">
          {HEADINGS[view.state]}
        </h1>
        {view.state === "paid" && <p className="text-sm text-ink-muted">Terima kasih. Pesananmu sedang kami siapkan.</p>}
        {view.state === "pending" && view.payBy && (
          <p className="text-sm text-ink-muted">
            Selesaikan pembayaran sebelum <span className="text-ink">{view.payBy}</span>. Lewat dari itu pesanan dibatalkan otomatis.
          </p>
        )}
        {view.state === "confirming" && (
          <p className="text-sm text-ink-muted">
            Batas waktu pembayaran sudah lewat. Kalau kamu sudah membayar, konfirmasinya sedang kami tunggu. Muat ulang halaman ini beberapa saat lagi untuk melihat statusnya. Jangan bayar dua kali.
          </p>
        )}
        {view.state === "refund_pending" && (
          <p className="text-sm text-ink-muted">
            Pesanan ini dibatalkan. Pembayaranmu sudah kami terima dan dananya akan kami kembalikan penuh. Kami akan menghubungimu lewat WhatsApp.
          </p>
        )}
        {view.state === "failed" && <p className="text-sm text-ink-muted">Waktu pembayaran pesanan ini sudah habis atau pembayarannya tidak berhasil. Kamu bisa pesan lagi kapan saja.</p>}
      </div>

      {view.state === "pending" &&
        (view.paymentUrl ? (
          // The payment page's own URL, as stored by the server when the order was placed.
          <a
            href={view.paymentUrl}
            className="inline-flex min-h-[54px] w-full items-center justify-center bg-pay px-6 text-xs font-medium tracking-[0.2em] text-ink uppercase"
          >
            Lanjutkan pembayaran
          </a>
        ) : (
          <ReopenPaymentButton orderNo={view.orderNo} />
        ))}
      {(view.state === "pending" || view.state === "confirming") && <PaymentStatusCheck orderNo={view.orderNo} />}

      <section aria-label="Ringkasan pesanan" className="flex flex-col gap-4 bg-surface p-4 md:p-6">
        <ul className="flex flex-col gap-3 text-sm">
          {view.lines.map((line, index) => (
            <li key={`${line.name}-${line.variant}-${index}`} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-ink">{line.name}</p>
                <p className="text-xs text-ink-muted">
                  {line.variant} · {line.qty}×
                </p>
              </div>
              <p className="shrink-0 text-ink">{formatPriceIdr(line.lineTotal)}</p>
            </li>
          ))}
        </ul>
        <dl className="flex flex-col gap-2 border-t border-line pt-4 text-sm text-ink">
          <div className="flex justify-between gap-4">
            <dt>Subtotal</dt>
            <dd>{formatPriceIdr(view.subtotal)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Ongkir{view.courierLabel ? ` (${view.courierLabel})` : ""}</dt>
            <dd data-testid="finish-shipping">{formatPriceIdr(view.shipping)}</dd>
          </div>
          {view.discount > 0 && (
            <div className="flex justify-between gap-4">
              <dt>Voucher</dt>
              <dd>-{formatPriceIdr(view.discount)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-line pt-3 text-base font-medium">
            <dt>Total</dt>
            <dd data-testid="finish-total">{formatPriceIdr(view.total)}</dd>
          </div>
        </dl>
      </section>

      <div className="flex flex-col gap-3">
        {view.isGuestOrder && view.guestContactEmail && <LoginPrefillLink email={view.guestContactEmail} />}
        {view.state === "failed" ? (
          <>
            {/* Puts the lines back into the cart; the server re-checks that the order is a
                cancelled, never-paid one (lib/orders/reorder-actions.ts). */}
            <ReorderButton orderNo={view.orderNo} />
            <OutlineLink href={COLLECTION_HREF} className="w-full">
              Lihat koleksi
            </OutlineLink>
          </>
        ) : (
          <OutlineLink href={COLLECTION_HREF} className="w-full">
            Lanjut belanja
          </OutlineLink>
        )}
      </div>
    </Container>
  );
}

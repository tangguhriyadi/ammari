import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isCartEnabled } from "@/lib/cart-flag";
import { formatPriceIdr } from "@/lib/format";
import { loadCustomerOrderDetail } from "@/lib/orders/queries";
import { loadOrderPageAccess } from "@/lib/orders/visitor-access";
import { Container } from "@/components/container";
import { PaymentStatusCheck } from "@/components/checkout/payment-status-check";
import { ReopenPaymentButton } from "@/components/checkout/reopen-payment-button";
import { ReorderButton } from "@/components/orders/reorder-button";

// One order (docs/plans/cart-checkout.md §9.1, §9.2; docs/design/storefront.md §7): lines, totals,
// address, status timeline, "Lanjutkan pembayaran" while payable, "Pesan lagi" when cancelled
// unpaid, and "Lacak pengiriman" (courier and resi before Phase K). Shown to the session the order
// belongs to, or to the browser holding the order's "Lihat pesanan" cookie (the email link's token,
// swapped by app/api/orders/[orderNo]/view before any page renders). Everyone else, an unknown
// number included, gets the same not-found answer. Works with the cart flag off too (plan §14: the
// email links must survive a rollback; owner decision 2026-10-21); "Pesan lagi", the status check
// and "Buka halaman pembayaran" need the flag, the stored payment link does not.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pesanan | Ammari",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

function Notice({ heading, text }: { heading: string; text: string }) {
  return (
    <Container className="flex max-w-[640px] flex-col gap-4 py-8 md:py-12">
      <h1 className="font-serif text-[30px] font-normal text-ink">{heading}</h1>
      <p className="text-sm text-ink-muted">{text}</p>
    </Container>
  );
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNo: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const [{ orderNo }, { status }] = await Promise.all([params, searchParams]);

  const pageAccess = await loadOrderPageAccess(orderNo);
  if (pageAccess.kind === "consent") redirect(pageAccess.to);
  // The token route's own refusals (`?status=`) only matter when nothing else opens the order, so
  // the query string never hides an order this visitor may see.
  if (pageAccess.kind === "limited" || (pageAccess.kind === "none" && status === "limited")) {
    return <Notice heading="Terlalu banyak percobaan" text="Coba buka lagi beberapa menit lagi." />;
  }
  if (pageAccess.kind === "error" || (pageAccess.kind === "none" && status === "error")) {
    return <Notice heading="Terjadi kesalahan" text="Pesanan belum bisa ditampilkan. Coba lagi sebentar lagi." />;
  }
  if (pageAccess.kind === "none") notFound();

  const order = await loadCustomerOrderDetail(pageAccess.access.orderId);
  if (!order) notFound();
  const cartEnabled = isCartEnabled();
  const viaSession = pageAccess.access.via === "session";

  return (
    <Container className="flex max-w-[640px] flex-col gap-8 py-8 md:py-12">
      <div className="flex flex-col gap-2">
        {viaSession && (
          <Link href="/orders" className="inline-flex min-h-[44px] items-center self-start text-xs text-ink-muted underline underline-offset-4">
            Pesanan saya
          </Link>
        )}
        <p className="text-xs text-ink-muted" aria-hidden="true">
          Pesanan {order.orderNo} · {order.orderedOn}
        </p>
        <h1 className="font-serif text-[30px] font-normal text-ink">
          <span className="sr-only">
            Pesanan {order.orderNo}, {order.orderedOn}:{" "}
          </span>
          <span data-testid="order-status">{order.status.label}</span>
        </h1>
        {order.status.note && <p className="text-sm text-ink-muted">{order.status.note}</p>}
        {order.status.payable && order.payBy && (
          <p className="text-sm text-ink-muted">
            Selesaikan pembayaran sebelum <span className="text-ink">{order.payBy}</span>. Lewat dari itu pesanan dibatalkan otomatis.
          </p>
        )}
        {order.status.confirming && (
          <p className="text-sm text-ink-muted">
            Batas waktu pembayaran sudah lewat. Kalau kamu sudah membayar, konfirmasinya sedang kami tunggu. Jangan bayar dua kali.
          </p>
        )}
      </div>

      {order.status.payable &&
        (order.paymentUrl ? (
          // The payment page's own URL, as stored by the server when the payment was created.
          <a
            href={order.paymentUrl}
            className="inline-flex min-h-[54px] w-full items-center justify-center bg-pay px-6 text-xs font-medium tracking-[0.2em] text-ink uppercase"
          >
            Lanjutkan pembayaran
          </a>
        ) : cartEnabled && viaSession ? (
          <ReopenPaymentButton orderNo={order.orderNo} />
        ) : (
          // A new payment attempt needs the buyer's session (plan §9.2: the emailed link only views).
          <p className="text-sm text-ink-muted">Halaman pembayaran belum bisa dibuka dari sini. Masuk dengan email yang kamu pakai saat memesan, atau hubungi kami lewat WhatsApp.</p>
        ))}
      {cartEnabled && (order.status.payable || order.status.confirming) && <PaymentStatusCheck orderNo={order.orderNo} />}
      {cartEnabled && order.status.reorderable && <ReorderButton orderNo={order.orderNo} />}

      {order.timeline.length > 0 && (
        <section aria-labelledby="order-timeline" className="flex flex-col gap-3">
          <h2 id="order-timeline" className="text-[11px] font-medium tracking-[0.24em] text-ink-muted uppercase">
            Status pesanan
          </h2>
          <ol className="flex flex-col gap-2 border-l border-line pl-4 text-sm">
            {order.timeline.map((entry, index) => (
              <li key={`${entry.label}-${index}`} className="flex flex-wrap justify-between gap-x-4">
                <span className="text-ink">{entry.label}</span>
                <span className="text-ink-muted">{entry.at}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {order.status.stage !== "cancelled" && (
        <section aria-labelledby="order-tracking" className="flex flex-col gap-2">
          <h2 id="order-tracking" className="text-[11px] font-medium tracking-[0.24em] text-ink-muted uppercase">
            Lacak pengiriman
          </h2>
          {order.shipment.trackingNumber ? (
            <dl className="flex flex-col gap-1 text-sm" data-testid="order-tracking">
              {order.shipment.courier && (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">Kurir</dt>
                  <dd className="text-ink">{order.shipment.courier}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Nomor resi</dt>
                <dd className="font-medium break-all text-ink">{order.shipment.trackingNumber}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-ink-muted">
              {order.status.stage === "shipped" || order.status.stage === "completed" || order.status.stage === "returned"
                ? "Pesanan sudah dikirim. Nomor resinya belum tersedia di sini."
                : "Nomor resi dikirim lewat email setelah pesanan dikirim."}
            </p>
          )}
        </section>
      )}

      <section aria-label="Ringkasan pesanan" className="flex flex-col gap-4 bg-surface p-4 md:p-6">
        <ul className="flex flex-col gap-3 text-sm">
          {order.lines.map((line, index) => (
            <li key={`${line.sku}-${index}`} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-ink">{line.name}</p>
                <p className="text-xs text-ink-muted">
                  {line.variant} · {line.qty}×
                </p>
              </div>
              {line.lineTotal !== null && <p className="shrink-0 text-ink">{formatPriceIdr(line.lineTotal)}</p>}
            </li>
          ))}
        </ul>
        {order.totals && (
          <dl className="flex flex-col gap-2 border-t border-line pt-4 text-sm text-ink">
            <div className="flex justify-between gap-4">
              <dt>Subtotal</dt>
              <dd>{formatPriceIdr(order.totals.subtotal)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Ongkir{order.totals.courierLabel ? ` (${order.totals.courierLabel})` : ""}</dt>
              <dd data-testid="order-shipping">{formatPriceIdr(order.totals.shipping)}</dd>
            </div>
            {order.totals.discount > 0 && (
              <div className="flex justify-between gap-4">
                <dt>Voucher</dt>
                <dd>-{formatPriceIdr(order.totals.discount)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4 border-t border-line pt-3 text-base font-medium">
              <dt>Total</dt>
              <dd data-testid="order-total">{formatPriceIdr(order.totals.total)}</dd>
            </div>
          </dl>
        )}
      </section>

      {order.address && (
        <section aria-labelledby="order-address" className="flex flex-col gap-2">
          <h2 id="order-address" className="text-[11px] font-medium tracking-[0.24em] text-ink-muted uppercase">
            Alamat pengiriman
          </h2>
          <p className="text-sm break-words text-ink">{order.address}</p>
        </section>
      )}
    </Container>
  );
}

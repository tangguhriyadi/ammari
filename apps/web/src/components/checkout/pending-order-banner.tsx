import Link from "next/link";
import { ChangePaymentMethodButton } from "./change-payment-method-button";
import { ReopenPaymentButton } from "./reopen-payment-button";

export interface PendingOrderBannerProps {
  orderNo: string;
  payBy: string;
  paymentUrl: string | null;
}

/** The buyer's own order still waiting for payment (lib/checkout/pending-order.ts), on /cart,
 * /checkout and the product pages of its items: the way back to the payment page after leaving it
 * with the back button (2026-10-21 sandbox run). Never names the payment gateway. */
export function PendingOrderBanner({ orderNo, payBy, paymentUrl }: PendingOrderBannerProps) {
  return (
    <section aria-labelledby="pending-order-heading" className="flex flex-col gap-4 border-l-2 border-brand bg-surface px-4 py-4" data-testid="pending-order-banner">
      <div className="flex flex-col gap-1">
        <h2 id="pending-order-heading" className="text-sm font-medium text-ink">
          Kamu punya pesanan {orderNo} yang menunggu pembayaran
        </h2>
        <p className="text-xs text-ink-muted">
          Selesaikan pembayaran sebelum <span className="text-ink">{payBy}</span>. Barang di pesanan ini kami simpan untukmu sampai batas waktu
          itu.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {paymentUrl ? (
          // The payment page's own URL, as stored by the server when the order was placed.
          <a
            href={paymentUrl}
            className="inline-flex min-h-[52px] w-full items-center justify-center bg-brand px-6 text-xs font-medium tracking-[0.2em] text-white uppercase hover:bg-ink"
          >
            Lanjutkan pembayaran
          </a>
        ) : (
          <ReopenPaymentButton orderNo={orderNo} />
        )}
        <ChangePaymentMethodButton orderNo={orderNo} />
        <Link
          href={`/checkout/finish?order=${encodeURIComponent(orderNo)}`}
          className="mx-auto flex min-h-11 items-center text-xs text-ink underline underline-offset-4"
        >
          Lihat detail pesanan
        </Link>
      </div>
    </section>
  );
}

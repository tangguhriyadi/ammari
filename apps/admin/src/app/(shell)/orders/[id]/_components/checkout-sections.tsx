import { Badge } from "@ammari/ui";
import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { CheckoutOrderDetail } from "@/lib/orders/queries";
import { CourierBooking } from "@/components/orders/courier-booking";
import { SHIPMENT_STATUS_BADGE_VARIANT, SHIPMENT_STATUS_LABELS, isLiveShipmentStatus, pickupCutoffHint, pickupStateLabel } from "@/lib/orders/shipment-labels";
import {
  ORDER_PAYMENT_STATUS_BADGE_VARIANT,
  ORDER_PAYMENT_STATUS_LABELS,
  PAYMENT_ATTEMPT_STATUS_LABELS,
  formatWeight,
  paymentMethodLabel,
} from "@/lib/orders/checkout-labels";

// The web checkout order's own sections on /orders/[id] (docs/plans/cart-checkout.md §4.5.6, §7,
// session 16): payment, the locked shipping quote, contact and address, voucher, emails. Read only;
// the actions live in checkout-actions.tsx.

const CANCEL_REASON_LABELS: Record<string, string> = {
  payment_expired: "Pembayaran kedaluwarsa",
  payment_cancelled: "Pembayaran dibatalkan pembeli",
  admin: "Dibatalkan staf",
};

const EMAIL_KIND_LABELS: Record<string, string> = {
  created: "Menunggu pembayaran",
  paid: "Pembayaran diterima",
  shipped: "Pesanan dikirim",
  delivered: "Pesanan sampai",
  cancelled: "Pesanan dibatalkan",
  owner_paid: "Pemberitahuan ke pemilik",
};

/** order_notifications state in words (session 13's `error` values: "superseded", "permanent: ...",
 * or a retryable reason). */
function emailStatus(email: { sentAt: Date | null; error: string | null }): string {
  if (email.sentAt) return `Terkirim ${formatDateTime(email.sentAt)}`;
  if (email.error === "superseded") return "Tidak dikirim (sudah tidak perlu)";
  if (email.error?.startsWith("permanent: ")) return "Gagal, tidak dicoba lagi";
  if (email.error) return "Gagal, dicoba lagi otomatis";
  return "Sedang dikirim";
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <span className="text-base text-neutral-900 break-words sm:text-right">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="text-lg font-semibold text-neutral-900">{title}</h2>
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">{children}</div>
    </section>
  );
}

export function PaymentSection({ checkout }: { checkout: CheckoutOrderDetail }) {
  const paidAttempt = checkout.attempts.find((attempt) => attempt.paidAt !== null);
  const method = paidAttempt ? paymentMethodLabel(paidAttempt.paymentType, paidAttempt.bank) : null;
  return (
    <Section title="Pembayaran">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-neutral-600">Status</span>
        <Badge variant={ORDER_PAYMENT_STATUS_BADGE_VARIANT[checkout.paymentStatus]}>{ORDER_PAYMENT_STATUS_LABELS[checkout.paymentStatus]}</Badge>
      </div>
      {method && <DetailRow label="Metode" value={method} />}
      {checkout.paidAt && <DetailRow label="Dibayar" value={formatDateTime(checkout.paidAt)} />}
      {checkout.paymentStatus === "pending" && checkout.paymentExpiresAt && <DetailRow label="Batas bayar" value={formatDateTime(checkout.paymentExpiresAt)} />}
      {checkout.cancelReason && <DetailRow label="Alasan batal" value={CANCEL_REASON_LABELS[checkout.cancelReason] ?? checkout.cancelReason} />}

      <h3 className="mt-2 text-base font-semibold text-neutral-900">Percobaan pembayaran</h3>
      {checkout.attempts.length === 0 ? (
        <p className="text-base text-neutral-600">Belum ada.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {checkout.attempts.map((attempt) => {
            const attemptMethod = paymentMethodLabel(attempt.paymentType, attempt.bank);
            return (
              <li key={attempt.id} className="flex flex-col gap-1 rounded-md bg-neutral-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-base font-medium text-neutral-900">Percobaan {attempt.attempt}</span>
                  <Badge variant={attempt.status === "paid" ? "success" : "neutral"}>{PAYMENT_ATTEMPT_STATUS_LABELS[attempt.status]}</Badge>
                </div>
                <p className="text-sm text-neutral-600 break-all">
                  {attempt.providerOrderId}
                  {attempt.providerRef ? ` · ID transaksi ${attempt.providerRef}` : ""}
                </p>
                <p className="text-sm text-neutral-600">
                  {formatRupiah(attempt.grossAmount)}
                  {attemptMethod ? ` · ${attemptMethod}` : ""}
                  {attempt.gatewayStatus ? ` · Midtrans: ${attempt.gatewayStatus}` : ""}
                  {` · dibuat ${formatDateTime(attempt.createdAt)}`}
                </p>
                {attempt.refundedAmount > 0 && <p className="text-sm text-neutral-700">Dikembalikan {formatRupiah(attempt.refundedAmount)}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export interface ShippingSectionProps {
  checkout: CheckoutOrderDetail;
  orderId: string;
  orderNo: string;
  /** Booking is offered only for a paid web order in to_ship (the server checks again). */
  canBook: boolean;
  canManage: boolean;
}

/** Why a booking attempt did not settle, in words (shipments.last_error is a reason and a code). */
function bookingErrorText(lastError: string | null): string | null {
  if (!lastError) return null;
  if (lastError.startsWith("duplicate_reference")) return "Biteship menyebut referensi ini sudah dipakai; cek di dashboard Biteship.";
  if (lastError.startsWith("refused")) return `Ditolak Biteship (${lastError.slice("refused:".length) || "tanpa kode"}).`;
  if (lastError.startsWith("budget_exhausted")) return "Batas harian pemakaian Biteship tercapai.";
  if (lastError === "invalid_data") return "Data pesanan ditolak sebelum dikirim.";
  return "Jawaban Biteship belum diterima.";
}

export function ShippingSection({ checkout, orderId, orderNo, canBook, canManage }: ShippingSectionProps) {
  const quote = checkout.quote;
  const live = checkout.shipments.find((shipment) => isLiveShipmentStatus(shipment.status)) ?? null;
  const ended = checkout.shipments.filter((shipment) => !isLiveShipmentStatus(shipment.status));
  const pickup = live ? pickupStateLabel(live.providerStatus) : null;
  const cutoff = quote && (!live || live.status === "booking" || live.status === "pickup_requested") ? pickupCutoffHint(quote.courierCode) : null;
  // The quote's cost is stripped for viewers without finance.view_profit, the booked cost too.
  const showsCost = quote?.costAmount !== null && quote?.costAmount !== undefined;
  return (
    <Section title="Pengiriman">
      {quote ? (
        <>
          <DetailRow label="Layanan" value={quote.courierLabel} />
          <DetailRow label="Berat" value={formatWeight(quote.weightGrams)} />
          {quote.destinationLabel && <DetailRow label="Tujuan" value={quote.destinationLabel} />}
          {quote.costAmount !== null && <DetailRow label="Ongkir kurir (checkout)" value={formatRupiah(quote.costAmount)} />}
          {quote.subsidyAmount !== null && <DetailRow label="Subsidi Ammari" value={formatRupiah(quote.subsidyAmount)} />}
          <DetailRow label="Dibayar pembeli" value={formatRupiah(quote.buyerAmount)} />
          <DetailRow label="Ongkir dihitung" value={formatDateTime(quote.quotedAt)} />
          <p className="text-sm text-neutral-600">Ongkir sudah terkunci di pesanan dan tidak bisa diubah. Kalau kurir dipesan manual, pakai layanan ini.</p>
        </>
      ) : (
        <p className="text-base text-neutral-600">Tidak ada data ongkir.</p>
      )}

      <h3 className="mt-2 text-base font-semibold text-neutral-900">Pemesanan kurir</h3>
      {live ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-600">Status</span>
            <Badge variant={SHIPMENT_STATUS_BADGE_VARIANT[live.status]}>{SHIPMENT_STATUS_LABELS[live.status]}</Badge>
          </div>
          <DetailRow label="Referensi" value={live.referenceId} />
          <DetailRow label="No. resi kurir" value={live.awb ?? "-"} />
          {pickup && <DetailRow label="Penjemputan" value={pickup} />}
          {live.routingCode && <DetailRow label="Kode rute" value={live.routingCode} />}
          {(live.driverName || live.driverPhone || live.driverPlateNumber) && (
            <DetailRow label="Kurir" value={[live.driverName, live.driverPhone, live.driverPlateNumber].filter(Boolean).join(" · ")} />
          )}
          {showsCost && (
            <DetailRow
              label="Biaya kurir sebenarnya"
              value={live.costAmount !== null ? `${formatRupiah(live.costAmount)} (checkout ${formatRupiah(quote!.costAmount!)})` : "Biaya belum diketahui"}
            />
          )}
          {live.bookedAt && <DetailRow label="Dipesan" value={formatDateTime(live.bookedAt)} />}
          {live.status === "booking" && (
            <p role="status" className="text-sm text-danger-700">
              Pemesanan belum pasti: kurir mungkin sudah dipesan. Tekan Cek ulang pemesanan. {bookingErrorText(live.lastError) ?? ""}
            </p>
          )}
          {live.cancelRequestedAt && (
            <p role="status" className="text-sm text-danger-700">
              Pembatalan sudah diminta tapi belum pasti. Tekan Cek ulang pemesanan.
            </p>
          )}
        </div>
      ) : (
        <p className="text-base text-neutral-600">{canBook ? "Kurir belum dipesan." : "Tidak ada pemesanan kurir yang aktif."}</p>
      )}
      {cutoff && <p className="text-sm text-neutral-600">{cutoff}</p>}
      {canManage && (live !== null || canBook) && (
        <CourierBooking orderId={orderId} orderNo={orderNo} shipment={live ? { status: live.status, awb: live.awb } : null} variant="section" />
      )}

      {ended.length > 0 && (
        <ul className="flex flex-col gap-1">
          {ended.map((shipment) => (
            <li key={shipment.id} className="text-sm text-neutral-600 break-words">
              Percobaan {shipment.attempt}: {SHIPMENT_STATUS_LABELS[shipment.status]}
              {shipment.awb ? ` · resi ${shipment.awb}` : ""}
              {shipment.status === "failed" && bookingErrorText(shipment.lastError) ? ` · ${bookingErrorText(shipment.lastError)}` : ""}
              {` · ${formatDateTime(shipment.cancelledAt ?? shipment.failedAt ?? shipment.createdAt)}`}
            </li>
          ))}
        </ul>
      )}
      {/* Courier and resi: the "Resi" section, with "Tambah resi" / "Ubah resi". */}
    </Section>
  );
}

export function ContactSection({ checkout, fallbackAddress }: { checkout: CheckoutOrderDetail; fallbackAddress: string | null }) {
  const address = checkout.address;
  return (
    <Section title="Kontak dan alamat">
      {checkout.contactEmail && <DetailRow label="Email" value={checkout.contactEmail} />}
      {checkout.contactPhone && <DetailRow label="WhatsApp" value={checkout.contactPhone} />}
      <DetailRow label="Masuk saat checkout" value={checkout.placedWithSession ? "Ya" : "Tidak (tamu)"} />
      <DetailRow label="Setuju promo" value={checkout.promoOptIn ? "Ya" : "Tidak"} />
      {address ? (
        <>
          <DetailRow label="Penerima" value={address.recipientName} />
          <DetailRow label="No. HP penerima" value={address.phone} />
          <DetailRow label="Alamat" value={address.addressLine} />
          <DetailRow label="Kecamatan" value={address.district} />
          <DetailRow label="Kota" value={address.city} />
          <DetailRow label="Provinsi" value={`${address.province} ${address.postalCode}`} />
          {address.notes && <DetailRow label="Catatan untuk kurir" value={address.notes} />}
        </>
      ) : (
        fallbackAddress && <DetailRow label="Alamat pengiriman" value={fallbackAddress} />
      )}
    </Section>
  );
}

export function VoucherAndEmailSection({ checkout, discountAmount }: { checkout: CheckoutOrderDetail; discountAmount: number }) {
  return (
    <Section title="Voucher dan email">
      <DetailRow
        label="Voucher"
        value={
          discountAmount > 0
            ? `${formatRupiah(discountAmount)}${checkout.voucher ? "" : " (sudah kembali ke pembeli)"}`
            : "Tidak pakai voucher"
        }
      />
      {checkout.emails.length === 0 ? (
        <DetailRow label="Email" value="Belum ada" />
      ) : (
        checkout.emails.map((email) => (
          <DetailRow
            key={email.kind}
            label={`Email: ${EMAIL_KIND_LABELS[email.kind] ?? email.kind}`}
            value={emailStatus(email)}
          />
        ))
      )}
    </Section>
  );
}

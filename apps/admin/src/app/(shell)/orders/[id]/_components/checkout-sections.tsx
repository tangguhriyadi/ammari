import { Badge } from "@ammari/ui";
import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { CheckoutOrderDetail, CheckoutShipment } from "@/lib/orders/queries";
import { CourierBooking } from "@/components/orders/courier-booking";
import { CopyValue } from "@/components/orders/copy-value";
import type { ShipmentStatus } from "@ammari/db/schema";
import { DetailList, DetailRow, Note, SectionCard, SubSection, TechnicalDetails } from "./section-card";
import { Timeline, type TimelineItem } from "./timeline";
import { ShipmentDetailsBlock } from "./shipment-details-block";
import {
  SHIPMENT_EVENT_SOURCE_LABELS,
  SHIPMENT_STATUS_BADGE_VARIANT,
  SHIPMENT_STATUS_LABELS,
  isLiveShipmentStatus,
  pickupCutoffHint,
  pickupStateLabel,
  shipmentEventLabel,
} from "@/lib/orders/shipment-labels";
import {
  ORDER_PAYMENT_STATUS_BADGE_VARIANT,
  ORDER_PAYMENT_STATUS_LABELS,
  PAYMENT_ATTEMPT_STATUS_LABELS,
  attentionFlagCopy,
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

export function PaymentSection({ checkout, className }: { checkout: CheckoutOrderDetail; className?: string }) {
  const paidAttempt = checkout.attempts.find((attempt) => attempt.paidAt !== null);
  const method = paidAttempt ? paymentMethodLabel(paidAttempt.paymentType, paidAttempt.bank) : null;
  return (
    <SectionCard title="Pembayaran" className={className}>
      <DetailList>
        <DetailRow label="Status" value={<Badge variant={ORDER_PAYMENT_STATUS_BADGE_VARIANT[checkout.paymentStatus]}>{ORDER_PAYMENT_STATUS_LABELS[checkout.paymentStatus]}</Badge>} />
        {method && <DetailRow label="Metode" value={method} />}
        {checkout.paidAt && <DetailRow label="Dibayar" value={formatDateTime(checkout.paidAt)} />}
        {checkout.paymentStatus === "pending" && checkout.paymentExpiresAt && <DetailRow label="Batas bayar" value={formatDateTime(checkout.paymentExpiresAt)} />}
        {checkout.cancelReason && <DetailRow label="Alasan batal" value={CANCEL_REASON_LABELS[checkout.cancelReason] ?? checkout.cancelReason} />}
      </DetailList>

      <SubSection title="Percobaan pembayaran">
        {checkout.attempts.length === 0 ? (
          <p className="text-base text-neutral-600">Belum ada.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {checkout.attempts.map((attempt) => {
              const attemptMethod = paymentMethodLabel(attempt.paymentType, attempt.bank);
              return (
                <li key={attempt.id} className="flex flex-col gap-1.5 rounded-md bg-neutral-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-base font-medium text-neutral-900">Percobaan {attempt.attempt}</span>
                    <Badge variant={attempt.status === "paid" ? "success" : "neutral"}>{PAYMENT_ATTEMPT_STATUS_LABELS[attempt.status]}</Badge>
                  </div>
                  <p className="text-sm text-neutral-600">
                    {formatRupiah(attempt.grossAmount)}
                    {attemptMethod ? ` · ${attemptMethod}` : ""}
                    {` · dibuat ${formatDateTime(attempt.createdAt)}`}
                  </p>
                  {attempt.refundedAmount > 0 && <p className="text-sm text-neutral-700">Dikembalikan {formatRupiah(attempt.refundedAmount)}</p>}
                  <TechnicalDetails>
                    <DetailList>
                      <DetailRow label="ID pesanan Midtrans" value={<CopyValue value={attempt.providerOrderId} label={`ID pesanan Midtrans (ke-${attempt.attempt})`} />} />
                      {attempt.providerRef && <DetailRow label="ID transaksi" value={<CopyValue value={attempt.providerRef} label={`ID transaksi Midtrans (ke-${attempt.attempt})`} />} />}
                      {attempt.gatewayStatus && <DetailRow label="Status Midtrans" value={attempt.gatewayStatus} />}
                    </DetailList>
                  </TechnicalDetails>
                </li>
              );
            })}
          </ul>
        )}
      </SubSection>
    </SectionCard>
  );
}

export interface ShippingSectionProps {
  checkout: CheckoutOrderDetail;
  orderId: string;
  orderNo: string;
  /** Booking is offered only for a paid web order in to_ship (the server checks again). */
  canBook: boolean;
  orderStatus: string;
  canManage: boolean;
  /** Courier and resi on the order itself (shown with "Ubah resi" once it has shipped). */
  courier: string | null;
  trackingNumber: string | null;
  className?: string;
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

/** Why the last automatic tracking read of a booked shipment failed (shipments.last_error `read:...`,
 * K3), in words; null when the last read went through. */
function trackingErrorText(lastError: string | null): string | null {
  if (!lastError?.startsWith("read:")) return null;
  const reason = lastError.slice("read:".length);
  if (reason === "budget_exhausted") return "Pelacakan otomatis tertunda: batas harian pemakaian Biteship tercapai. Dicek lagi besok, atau tekan Cek ulang pemesanan.";
  if (reason === "unavailable") return "Pelacakan otomatis tertunda: Biteship belum bisa dihubungi. Dicek lagi otomatis.";
  return "Pelacakan otomatis gagal membaca pengiriman ini. Cek di dashboard Biteship.";
}

/** The shipping flags on the order, next to the facts staff check them against (K4). */
function ShippingFlagContext({ flags, live, trackingNumber }: { flags: readonly string[]; live: CheckoutShipment | null; trackingNumber: string | null }) {
  const lines: { flag: string; text: string }[] = [];
  if (flags.includes("tracking_stale")) {
    const since = live?.lastEventAt ?? live?.bookedAt ?? null;
    lines.push({
      flag: "tracking_stale",
      text: `Kabar terakhir dari kurir: ${since ? formatDateTime(since) : "belum ada"}${live?.lastPolledAt ? `. Dicek terakhir ${formatDateTime(live.lastPolledAt)}` : ""}.`,
    });
  }
  if (flags.includes("delivery_problem")) {
    lines.push({
      flag: "delivery_problem",
      text: live
        ? `Status terakhir dari kurir: ${live.providerStatus ?? "-"} (${SHIPMENT_STATUS_LABELS[live.status]}). Lihat riwayat pelacakan di bawah.`
        : "Tidak ada pemesanan kurir yang aktif: pengiriman terakhir berakhir. Lihat percobaan dan riwayat pelacakan di bawah.",
    });
  }
  if (flags.includes("tracking_number_mismatch")) {
    lines.push({
      flag: "tracking_number_mismatch",
      text:
        live?.status === "booking"
          ? `Resi di pesanan: ${trackingNumber ?? "-"}. Pemesanan kurir belum pasti; tekan Cek ulang pemesanan. Kalau kurir ternyata dipesan dan paket dikirim dengan cara lain, batalkan pengiriman itu sebelum dijemput.`
          : `Resi di pesanan: ${trackingNumber ?? "-"}. Resi dari pesanan kurir: ${live?.awb ?? "-"}. Pembeli tidak melihat riwayat pelacakan sampai keduanya sama.`,
    });
  }
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Tanda pengiriman">
      {lines.map((line) => (
        <li key={line.flag} className="flex flex-col gap-0.5 rounded-md border border-danger-700/40 bg-danger-50 p-3" data-testid={`shipping-flag-${line.flag}`}>
          <span className="text-sm font-semibold text-neutral-900">Perlu dicek: {attentionFlagCopy(line.flag).label}</span>
          <span className="text-sm text-neutral-700 break-words">{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The booked waybill and the order's resi are the same parcel when they only differ in spacing or case. */
function sameResi(a: string, b: string): boolean {
  return a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
}

/** Milestones of a parcel on its way, in order; the ones after the live status are "waiting". */
const TRACKING_FLOW: readonly ShipmentStatus[] = ["pickup_requested", "picked_up", "in_transit", "delivered"];

/** The history's wording of a status ("Terkirim" for a delivered parcel). */
function trackingTitle(status: ShipmentStatus | null): string {
  return status === "delivered" ? "Terkirim" : shipmentEventLabel(status);
}

/** Every attempt's courier history, newest first, as a timeline: the latest event is the current
 * step, milestones not reached yet wait above it (K4). */
function TrackingHistory({ events, attempts, liveStatus }: { events: CheckoutOrderDetail["trackingEvents"]; attempts: number; liveStatus: ShipmentStatus | null }) {
  if (events.length === 0) {
    return (
      <SubSection title="Riwayat pelacakan">
        <p className="text-base text-neutral-600">Belum ada kabar dari kurir.</p>
      </SubSection>
    );
  }
  const sorted = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  const seen = new Set(sorted.map((event) => event.normalizedStatus));
  const liveRank = liveStatus ? TRACKING_FLOW.indexOf(liveStatus) : -1;
  const waiting: TimelineItem[] = TRACKING_FLOW.slice(liveRank + 1)
    .filter((status) => liveRank >= 0 && !seen.has(status))
    .reverse()
    .map((status) => ({ key: `waiting-${status}`, title: trackingTitle(status), state: "waiting" as const }));
  const done: TimelineItem[] = sorted.map((event, index) => {
    const older = sorted[index + 1];
    const meta = [SHIPMENT_EVENT_SOURCE_LABELS[event.source] ?? event.source, event.providerStatus, attempts > 1 ? `percobaan ${event.attempt}` : null].filter(Boolean).join(" · ");
    return {
      key: event.id,
      title: trackingTitle(event.normalizedStatus),
      state: index === 0 ? "current" : "done",
      time: event.occurredAt,
      meta,
      description: [event.description, event.location].filter(Boolean).join(" · ") || undefined,
      repeatedTitle: older !== undefined && older.normalizedStatus === event.normalizedStatus,
    };
  });
  return (
    <SubSection title="Riwayat pelacakan">
      <Timeline items={[...waiting, ...done]} testId="admin-tracking-history" />
    </SubSection>
  );
}

export function ShippingSection({ checkout, orderId, orderNo, canBook, canManage, orderStatus, courier, trackingNumber, className }: ShippingSectionProps) {
  const quote = checkout.quote;
  const live = checkout.shipments.find((shipment) => isLiveShipmentStatus(shipment.status)) ?? null;
  const ended = checkout.shipments.filter((shipment) => !isLiveShipmentStatus(shipment.status));
  const pickup = live ? pickupStateLabel(live.providerStatus) : null;
  const trackingError = live && live.status !== "booking" ? trackingErrorText(live.lastError) : null;
  const cutoff = quote && (!live || live.status === "booking" || live.status === "pickup_requested") ? pickupCutoffHint(quote.courierCode) : null;
  // The quote's cost is stripped for viewers without finance.view_profit, the booked cost too.
  const showsCost = quote?.costAmount !== null && quote?.costAmount !== undefined;
  // Courier and resi of a shipped order ("Tambah resi" / "Ubah resi"), one place for web and manual orders.
  const showResi = orderStatus === "shipped" || orderStatus === "completed";
  // The booking's own waybill row repeats the order's resi when both are the same.
  const waybillIsOrderResi = showResi && live?.awb != null && trackingNumber !== null && sameResi(live.awb, trackingNumber);
  const courierRepeatsQuote = courier !== null && quote !== null && courier.trim().toLowerCase() === quote.courierLabel.trim().toLowerCase();
  const resiBlock = showResi && (
    <ShipmentDetailsBlock
      orderId={orderId}
      orderNo={orderNo}
      courier={courier}
      trackingNumber={trackingNumber}
      isCheckout
      bookedWaybill={checkout.shipments.find((shipment) => shipment.status !== "cancelled" && shipment.status !== "failed" && shipment.status !== "booking")?.awb ?? null}
      canManage={canManage}
      hideCourier={courierRepeatsQuote}
    />
  );
  return (
    <SectionCard title="Pengiriman" id="pengiriman" className={className}>
      <ShippingFlagContext flags={checkout.needsAttention} live={live} trackingNumber={checkout.trackingNumber} />
      {quote ? (
        <>
          <DetailList>
            <DetailRow label="Layanan" value={quote.courierLabel} />
            <DetailRow label="Berat" value={formatWeight(quote.weightGrams)} />
            {quote.destinationLabel && <DetailRow label="Tujuan" value={quote.destinationLabel} />}
            {quote.costAmount !== null && <DetailRow label="Ongkir kurir (checkout)" value={formatRupiah(quote.costAmount)} />}
            {quote.subsidyAmount !== null && <DetailRow label="Subsidi Ammari" value={formatRupiah(quote.subsidyAmount)} />}
            <DetailRow label="Dibayar pembeli" value={formatRupiah(quote.buyerAmount)} />
            <DetailRow label="Ongkir dihitung" value={formatDateTime(quote.quotedAt)} />
          </DetailList>
          <Note>Ongkir sudah terkunci di pesanan dan tidak bisa diubah. Kalau kurir dipesan manual, pakai layanan ini.</Note>
        </>
      ) : (
        <p className="text-base text-neutral-600">Tidak ada data ongkir.</p>
      )}

      <SubSection title="Pemesanan kurir">
        {live ? (
          <div className="flex flex-col gap-3">
            <DetailList>
              <DetailRow label="Status" value={<Badge variant={SHIPMENT_STATUS_BADGE_VARIANT[live.status]}>{SHIPMENT_STATUS_LABELS[live.status]}</Badge>} />
              {!waybillIsOrderResi && (
                <DetailRow label="No. resi kurir" value={live.awb ? <CopyValue value={live.awb} label="nomor resi kurir" /> : "-"} />
              )}
            </DetailList>
            {resiBlock}
            <DetailList>
              {pickup && <DetailRow label="Penjemputan" value={pickup} />}
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
              {live.status !== "booking" && (
                <DetailRow label="Kabar terakhir dari kurir" value={live.lastEventAt ? formatDateTime(live.lastEventAt) : "Belum ada"} />
              )}
            </DetailList>
            {live.status === "booking" && (
              <p role="status" className="text-sm text-danger-700">
                Pemesanan belum pasti: kurir mungkin sudah dipesan. Tekan Cek ulang pemesanan. {bookingErrorText(live.lastError) ?? ""}
              </p>
            )}
            {orderStatus === "completed" && live.status !== "delivered" && live.status !== "booking" && live.status !== "returned" && (
              <Note role="status" testId="poll-stopped">
                Pengecekan otomatis berkala berhenti karena pesanan ditandai selesai oleh staf. Kabar dari webhook kurir tetap dicatat; tekan Cek ulang pemesanan untuk membaca sekarang.
              </Note>
            )}
            {live.awb && checkout.trackingNumber && !sameResi(live.awb, checkout.trackingNumber) && (
              <p role="status" className="text-sm text-danger-700" data-testid="buyer-timeline-hidden">
                Pembeli tidak melihat riwayat kurir: resi di pesanan ({checkout.trackingNumber}) berbeda dengan resi pesanan kurir.
              </p>
            )}
            {trackingError && <Note role="status">{trackingError}</Note>}
            {live.cancelRequestedAt && (
              <p role="status" className="text-sm text-danger-700">
                Pembatalan sudah diminta tapi belum pasti. Tekan Cek ulang pemesanan.
              </p>
            )}
          </div>
        ) : (
          <>
            <p className="text-base text-neutral-600">{canBook ? "Kurir belum dipesan." : "Tidak ada pemesanan kurir yang aktif."}</p>
            {resiBlock}
          </>
        )}
        {cutoff && <Note>{cutoff}</Note>}
        {canManage && (live !== null || canBook) && (
          <CourierBooking orderId={orderId} orderNo={orderNo} shipment={live ? { status: live.status, awb: live.awb } : null} variant="section" />
        )}

        {live && (
          <TechnicalDetails>
            <DetailList>
              <DetailRow label="Referensi" value={live.referenceId} />
              {live.providerOrderId && (
                <DetailRow
                  label="ID pesanan Biteship"
                  value={<CopyValue value={live.providerOrderId} label={`ID pesanan Biteship percobaan ${live.attempt}`} testId={`provider-order-id-${live.attempt}`} />}
                />
              )}
              {live.providerStatus && <DetailRow label="Status Biteship" value={live.providerStatus} />}
              {live.routingCode && <DetailRow label="Kode rute" value={live.routingCode} />}
              {live.lastPolledAt && <DetailRow label="Dicek otomatis terakhir" value={formatDateTime(live.lastPolledAt)} />}
            </DetailList>
          </TechnicalDetails>
        )}

        {ended.length > 0 && (
          <ul className="flex flex-col gap-2">
            {ended.map((shipment) => (
              <li key={shipment.id} className="flex flex-col gap-1">
                <p className="text-sm text-neutral-600 break-words">
                  Percobaan {shipment.attempt}: {SHIPMENT_STATUS_LABELS[shipment.status]}
                  {shipment.awb ? ` · resi ${shipment.awb}` : ""}
                  {shipment.status === "failed" && bookingErrorText(shipment.lastError) ? ` · ${bookingErrorText(shipment.lastError)}` : ""}
                  {` · ${formatDateTime(shipment.cancelledAt ?? shipment.failedAt ?? shipment.createdAt)}`}
                </p>
                {shipment.providerOrderId && (
                  <TechnicalDetails>
                    <DetailList>
                      <DetailRow
                        label="ID pesanan Biteship"
                        value={<CopyValue value={shipment.providerOrderId} label={`ID pesanan Biteship percobaan ${shipment.attempt}`} testId={`provider-order-id-${shipment.attempt}`} />}
                      />
                    </DetailList>
                  </TechnicalDetails>
                )}
              </li>
            ))}
          </ul>
        )}
      </SubSection>

      {checkout.shipments.length > 0 && <TrackingHistory events={checkout.trackingEvents} attempts={checkout.shipments.length} liveStatus={live?.status ?? null} />}
    </SectionCard>
  );
}

export function ContactSection({ checkout, fallbackAddress, className }: { checkout: CheckoutOrderDetail; fallbackAddress: string | null; className?: string }) {
  const address = checkout.address;
  return (
    <SectionCard title="Kontak dan alamat" className={className}>
      <DetailList>
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
      </DetailList>
    </SectionCard>
  );
}

export function VoucherAndEmailSection({ checkout, discountAmount, className }: { checkout: CheckoutOrderDetail; discountAmount: number; className?: string }) {
  return (
    <SectionCard title="Voucher dan email" className={className}>
      <DetailList>
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
            <DetailRow key={email.kind} label={`Email: ${EMAIL_KIND_LABELS[email.kind] ?? email.kind}`} value={emailStatus(email)} />
          ))
        )}
      </DetailList>
    </SectionCard>
  );
}

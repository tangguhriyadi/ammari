import { notFound } from "next/navigation";
import { Badge, Breadcrumb } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah, formatShortDate } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getOrderDetail, stripOrderDetailCost } from "@/lib/orders/queries";
import { ORDER_STATUS_TRANSITIONS } from "@ammari/commerce/order-status";
import { sizeLabel } from "@ammari/commerce/size-label";
import { ORDER_STATUS_BADGE_VARIANT, ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { StatusActions } from "./_components/status-actions";
import { refundsOwed } from "@ammari/commerce/payments";
import { AttentionPanel, CheckoutStatusActions, type RefundableAttempt } from "./_components/checkout-actions";
import { ContactSection, PaymentSection, ShippingSection, VoucherAndEmailSection } from "./_components/checkout-sections";
import { ShipmentDetailsBlock } from "./_components/shipment-details-block";
import { DetailList, DetailRow, SectionCard } from "./_components/section-card";
import { Timeline, type TimelineItem } from "./_components/timeline";
import { MarketplaceSection } from "./_components/marketplace-section";
import { productDiscountSummary } from "@/lib/orders/product-discount-summary";
import { isOpenShipmentStatus } from "@/lib/orders/shipment-labels";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("orders.view");
  const { id } = await params;

  const detailRaw = await getOrderDetail(id);
  if (!detailRaw) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("orders.manage");
  const detail = stripOrderDetailCost(detailRaw, canViewProfit);
  // Web checkout order data (docs/plans/cart-checkout.md §7, session 16); null for manual and
  // marketplace orders, which render exactly as before.
  const checkout = detail.checkout;
  const discountSummary = productDiscountSummary(detail.items, detail.subtotalAmount);
  const refundableAttempts: RefundableAttempt[] = (checkout?.attempts ?? [])
    .filter((attempt) => attempt.status === "paid" || attempt.status === "partially_refunded")
    .map((attempt) => ({ paymentId: attempt.id, attempt: attempt.attempt, amount: attempt.grossAmount - attempt.refundedAmount }));

  // The courier booking's waybill (Phase K2) prefills and checks the resi in "Tandai dikirim" / "Ubah resi".
  const bookedWaybill = checkout?.shipments.find((shipment) => shipment.status !== "cancelled" && shipment.status !== "failed" && shipment.status !== "booking")?.awb ?? null;

  // Order status history, newest first (the latest step is the current one).
  const historySteps = [
    { label: "Dibuat", at: detail.createdAt },
    { label: "Dibayar", at: checkout?.paidAt ?? null },
    { label: "Dikirim", at: detail.shippedAt },
    { label: "Selesai", at: detail.completedAt },
    { label: "Dibatalkan", at: detail.cancelledAt },
    { label: "Retur", at: detail.returnedAt },
  ]
    .map((step, order) => ({ ...step, order }))
    .filter((step): step is { label: string; at: Date; order: number } => step.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.order - a.order);
  const historyItems: TimelineItem[] = historySteps.map((step, index) => ({
    key: step.label,
    title: step.label,
    state: index === 0 ? "current" : "done",
    time: step.at,
  }));
  const shipped = detail.status === "shipped" || detail.status === "completed";

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/orders"), { label: detail.orderNo }]} />
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-balance font-serif text-3xl font-light text-neutral-900">{detail.orderNo}</h1>
            <Badge variant={ORDER_STATUS_BADGE_VARIANT[detail.status]}>{ORDER_STATUS_LABELS[detail.status]}</Badge>
            {detail.needsAttention.includes("marketplace_return_pending") && (
              <Badge variant="warning" className="whitespace-nowrap" data-testid="marketplace-return-badge">
                Retur di marketplace
              </Badge>
            )}
            {detail.cardClaimedAt && (
              <Badge variant="success" className="whitespace-nowrap">
                Diklaim · {formatShortDate(detail.cardClaimedAt)}
              </Badge>
            )}
          </div>
          <p className="text-pretty text-base text-neutral-600">{`${detail.channelName} · ${formatDate(new Date(detail.orderDate))}`}</p>
        </header>

        {(checkout || detail.needsAttention.length > 0) && (
          <AttentionPanel
            orderId={detail.id}
            status={detail.status}
            flags={detail.needsAttention}
            refundableAttempts={refundableAttempts}
            refundOwed={refundsOwed(detail.status, refundableAttempts.length) > 0}
            canManage={canManage}
            bookedWaybill={bookedWaybill}
            trackingNumber={detail.trackingNumber}
          />
        )}

        {canManage &&
          (checkout ? (
            <CheckoutStatusActions
              orderId={detail.id}
              orderNo={detail.orderNo}
              status={detail.status}
              paymentStatus={checkout.paymentStatus}
              totalAmount={detail.totalAmount}
              quotedCourierLabel={checkout.quote?.courierLabel ?? null}
              bookedWaybill={bookedWaybill}
              allowedTransitions={[...ORDER_STATUS_TRANSITIONS[detail.status]]}
              courierDelivered={checkout.shipments.some((shipment) => shipment.status === "delivered")}
              openBooking={checkout.shipments.some((shipment) => isOpenShipmentStatus(shipment.status))}
            />
          ) : (
            <StatusActions orderId={detail.id} allowedTransitions={[...ORDER_STATUS_TRANSITIONS[detail.status]]} />
          ))}

        {/* Two columns from lg: items and shipping left, the rest right. The columns dissolve on a
            phone (`contents`) and the cards follow `order-*`: summary, items, shipping, payment,
            contact, emails, history. */}
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-3 lg:items-start">
          <div className="contents lg:col-span-2 lg:flex lg:flex-col lg:gap-4">
            <SectionCard title="Item" className="order-3 lg:order-none">
              <ul className="flex flex-col divide-y divide-neutral-200">
                {detail.items.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-base text-neutral-900">
                        {item.productName} <span className="text-sm text-neutral-600">{item.colorName} · {sizeLabel(item.size)}</span>
                      </p>
                      <p className="text-sm text-neutral-600">
                        {item.qty} x{" "}
                        {item.listUnitPrice !== null && item.listUnitPrice > item.unitPrice && (
                          <>
                            <span className="sr-only">Harga normal </span>
                            <s data-testid="order-item-list-price">{formatRupiah(item.listUnitPrice)}</s>{" "}
                            <span className="sr-only">harga dibayar </span>
                          </>
                        )}
                        <span data-testid="order-item-unit-price">{formatRupiah(item.unitPrice)}</span>
                        {item.unitCost !== null && <span className="ml-2">· HPP {formatRupiah(item.unitCost)}/pcs</span>}
                      </p>
                    </div>
                    <span className="whitespace-nowrap text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(item.qty * item.unitPrice)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 sm:ml-auto sm:w-full sm:max-w-sm">
                {discountSummary && (
                  <>
                    <TotalRow label="Harga normal" value={formatRupiah(discountSummary.listTotal)} testId="order-list-total" />
                    <TotalRow label="Diskon produk" value={`- ${formatRupiah(discountSummary.discount)}`} testId="order-product-discount" />
                  </>
                )}
                <TotalRow label="Subtotal" value={formatRupiah(detail.subtotalAmount)} />
                <TotalRow label={checkout ? "Ongkir (dibayar pembeli)" : "Ongkos kirim"} value={formatRupiah(detail.shippingAmount)} />
                <TotalRow label={checkout ? "Voucher" : "Diskon"} value={`- ${formatRupiah(detail.discountAmount)}`} />
                <TotalRow label="Total" value={formatRupiah(detail.totalAmount)} strong />
              </div>
              {checkout && <p className="text-sm text-neutral-600">Pesanan dari checkout website: item dan ongkir tidak bisa diubah.</p>}
            </SectionCard>

            {checkout ? (
              <ShippingSection
                checkout={checkout}
                orderId={detail.id}
                orderNo={detail.orderNo}
                canBook={detail.status === "to_ship" && checkout.paymentStatus === "paid"}
                canManage={canManage}
                orderStatus={detail.status}
                courier={detail.courier}
                trackingNumber={detail.trackingNumber}
                className="order-4 lg:order-none"
              />
            ) : (
              shipped && (
                <SectionCard title="Pengiriman" id="pengiriman" className="order-4 lg:order-none">
                  <ShipmentDetailsBlock
                    orderId={detail.id}
                    orderNo={detail.orderNo}
                    courier={detail.courier}
                    trackingNumber={detail.trackingNumber}
                    isCheckout={false}
                    bookedWaybill={bookedWaybill}
                    canManage={canManage}
                  />
                </SectionCard>
              )
            )}
          </div>

          <div className="contents lg:flex lg:flex-col lg:gap-4">
            <SectionCard title="Ringkasan" className="order-1 lg:order-none">
              <DetailList>
                <DetailRow label="Pelanggan" value={detail.customerName ?? detail.buyerUsername ?? "-"} />
                {detail.customerPhone && <DetailRow label="No. HP" value={detail.customerPhone} />}
                {detail.channelOrderNo && <DetailRow label="No. pesanan marketplace" value={detail.channelOrderNo} />}
                {!checkout && detail.shippingAddress && <DetailRow label="Alamat pengiriman" value={detail.shippingAddress} />}
                {detail.notes && <DetailRow label="Catatan" value={detail.notes} />}
                <DetailRow label="Dicatat" value={`${formatDateTime(detail.createdAt)}${detail.createdByName ? ` · ${detail.createdByName}` : ""}`} />
                <DetailRow label="Status" value={<Badge variant={ORDER_STATUS_BADGE_VARIANT[detail.status]}>{ORDER_STATUS_LABELS[detail.status]}</Badge>} />
              </DetailList>
            </SectionCard>

            {detail.marketplace && (
              <MarketplaceSection
                marketplace={detail.marketplace}
                canViewProfit={canViewProfit}
                canViewImports={session.permissionKeys.includes("orders.import")}
                className="order-2 lg:order-none"
              />
            )}

            {checkout && (
              <>
                <PaymentSection checkout={checkout} className="order-5 lg:order-none" />
                <ContactSection checkout={checkout} fallbackAddress={detail.shippingAddress} className="order-6 lg:order-none" />
                <VoucherAndEmailSection checkout={checkout} discountAmount={detail.discountAmount} className="order-7 lg:order-none" />
              </>
            )}

            <SectionCard title="Riwayat status" className="order-8 lg:order-none">
              <Timeline items={historyItems} compact label="Riwayat status pesanan" />
            </SectionCard>
          </div>
        </div>
      </div>
    </>
  );
}

function TotalRow({ label, value, testId, strong = false }: { label: string; value: string; testId?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`text-sm ${strong ? "font-semibold text-neutral-900" : "text-neutral-600"}`}>{label}</span>
      <span className={`tabular-nums text-neutral-900 ${strong ? "text-lg font-semibold" : "text-base"}`} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

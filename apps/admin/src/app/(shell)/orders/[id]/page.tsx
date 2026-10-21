import { notFound } from "next/navigation";
import { Badge, Breadcrumb, PageHeader } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah, formatShortDate } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getOrderDetail, stripOrderDetailCost } from "@/lib/orders/queries";
import { ORDER_STATUS_TRANSITIONS } from "@ammari/commerce/order-status";
import { ORDER_STATUS_BADGE_VARIANT, ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { StatusActions } from "./_components/status-actions";
import { refundsOwed } from "@ammari/commerce/payments";
import { AttentionPanel, CheckoutStatusActions, type RefundableAttempt } from "./_components/checkout-actions";
import { ContactSection, PaymentSection, ShippingSection, VoucherAndEmailSection } from "./_components/checkout-sections";

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
  const refundableAttempts: RefundableAttempt[] = (checkout?.attempts ?? [])
    .filter((attempt) => attempt.status === "paid" || attempt.status === "partially_refunded")
    .map((attempt) => ({ paymentId: attempt.id, attempt: attempt.attempt, amount: attempt.grossAmount - attempt.refundedAmount }));

  const timeline = [
    { label: "Dibuat", at: detail.createdAt },
    { label: "Dikirim", at: detail.shippedAt },
    { label: "Selesai", at: detail.completedAt },
    { label: "Dibatalkan", at: detail.cancelledAt },
    { label: "Retur", at: detail.returnedAt },
  ].filter((step): step is { label: string; at: Date } => step.at !== null);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/orders"), { label: detail.orderNo }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader title={detail.orderNo} description={`${detail.channelName} · ${formatDate(new Date(detail.orderDate))}`} />
        <div className="flex items-center gap-2">
          <Badge variant={ORDER_STATUS_BADGE_VARIANT[detail.status]}>{ORDER_STATUS_LABELS[detail.status]}</Badge>
          {detail.cardClaimedAt && (
            <Badge variant="success" className="whitespace-nowrap">
              Diklaim · {formatShortDate(detail.cardClaimedAt)}
            </Badge>
          )}
        </div>
      </div>

      {checkout && (
        <AttentionPanel
          orderId={detail.id}
          status={detail.status}
          flags={checkout.needsAttention}
          refundableAttempts={refundableAttempts}
          refundOwed={refundsOwed(detail.status, refundableAttempts.length) > 0}
          canManage={canManage}
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
            allowedTransitions={[...ORDER_STATUS_TRANSITIONS[detail.status]]}
          />
        ) : (
          <StatusActions orderId={detail.id} allowedTransitions={[...ORDER_STATUS_TRANSITIONS[detail.status]]} />
        ))}

      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
        <Row label="Pelanggan" value={detail.customerName ?? detail.buyerUsername ?? "-"} />
        {detail.customerPhone && <Row label="No. HP" value={detail.customerPhone} />}
        {detail.channelOrderNo && <Row label="No. pesanan marketplace" value={detail.channelOrderNo} />}
        {!checkout && detail.shippingAddress && <Row label="Alamat pengiriman" value={detail.shippingAddress} />}
        {detail.notes && <Row label="Catatan" value={detail.notes} />}
        <Row label="Dicatat" value={`${formatDateTime(detail.createdAt)}${detail.createdByName ? ` · ${detail.createdByName}` : ""}`} />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">Item</h2>
        <ul className="flex flex-col gap-2">
          {detail.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3">
              <div>
                <p className="text-base text-neutral-900">
                  {item.productName} <span className="text-sm text-neutral-600">{item.colorName} · {item.size}</span>
                </p>
                <p className="text-sm text-neutral-600">
                  {item.qty} x {formatRupiah(item.unitPrice)}
                  {item.unitCost !== null && <span className="ml-2">· HPP {formatRupiah(item.unitCost)}/pcs</span>}
                </p>
              </div>
              <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(item.qty * item.unitPrice)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
        <Row label="Subtotal" value={formatRupiah(detail.subtotalAmount)} />
        <Row label={checkout ? "Ongkir (dibayar pembeli)" : "Ongkos kirim"} value={formatRupiah(detail.shippingAmount)} />
        <Row label={checkout ? "Voucher" : "Diskon"} value={`- ${formatRupiah(detail.discountAmount)}`} />
        <Row label="Total" value={formatRupiah(detail.totalAmount)} />
      </div>
      {checkout && (
        <p className="text-sm text-neutral-600">Pesanan dari checkout website: item dan ongkir tidak bisa diubah.</p>
      )}

      {checkout && (
        <>
          <PaymentSection checkout={checkout} />
          <ShippingSection checkout={checkout} />
          <ContactSection checkout={checkout} fallbackAddress={detail.shippingAddress} />
          <VoucherAndEmailSection checkout={checkout} discountAmount={detail.discountAmount} />
        </>
      )}

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-900">Riwayat status</h2>
        <ul className="flex flex-col gap-1">
          {timeline.map((step) => (
            <li key={step.label} className="flex items-center justify-between text-base text-neutral-700">
              <span>{step.label}</span>
              <span className="tabular-nums">{formatDateTime(step.at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <span className="text-base text-neutral-900">{value}</span>
    </div>
  );
}

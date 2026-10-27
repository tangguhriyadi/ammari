import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, Card, CardList, EmptyState, PageHeader, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatDateTime, formatNumber, formatRupiah } from "@ammari/ui/lib";
import { addCalendarDays, jakartaDate } from "@ammari/commerce/jakarta-day";
import { endOfJakartaDay, latestExtensionDate } from "@ammari/commerce/voucher-adjustments";
import { requirePermission } from "@/lib/auth/require-permission";
import { DETAIL_ORDER_LIMIT, getCustomerDetail, type CustomerVoucherRow, type VoucherAdjustmentRow } from "@/lib/customers/directory";
import { CUSTOMER_TYPE_LABELS, SIGN_IN_METHOD_LABELS, THANK_YOU_CARD_STATUS_LABELS, VOUCHER_STATUS_BADGE } from "@/lib/customers/labels";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ORDER_STATUS_BADGE_VARIANT, ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { VOUCHER_STATUS_LABELS } from "@/lib/vouchers/status";
import { ExtendVoucherButton, VoidVoucherButton } from "../_components/voucher-actions";
import { WithdrawPromoButton } from "../_components/withdraw-promo-button";

// Customer detail (docs/plans/growth.md §8.3, §9.3; sessions S4 and S5), phone first: Profil,
// Persetujuan, Pesanan, Voucher, Kartu terima kasih diklaim. customers.view sees the full email and
// phone (CS replies on WhatsApp) but never an order's contact snapshot or address (§8.1). No
// identity editing (A10). Promo withdrawal needs customers.manage; void/extend need vouchers.void
// (owner, super_admin); the voucher history is visible to everyone here.

function Section({ id, title, description, actions, children }: { id: string; title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 id={id} className="text-lg font-semibold text-neutral-900">
            {title}
          </h2>
          {description && <p className="text-sm text-neutral-600">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-base text-neutral-900">{children}</dd>
    </div>
  );
}

function adjustmentLine(adjustment: VoucherAdjustmentRow): string {
  const who = adjustment.staffName ? ` oleh ${adjustment.staffName}` : "";
  const what =
    adjustment.kind === "void"
      ? "Dibatalkan"
      : `Diperpanjang dari ${formatDate(adjustment.previousExpiresAt)} ke ${formatDate(adjustment.newExpiresAt ?? adjustment.previousExpiresAt)}`;
  return `${what}${who}, ${formatDateTime(adjustment.createdAt)}. Alasan: ${adjustment.reason}`;
}

function VoucherHistory({ voucher }: { voucher: CustomerVoucherRow }) {
  if (voucher.adjustments.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm text-neutral-700" aria-label={`Riwayat voucher ${voucher.cardOrderNo}`} data-testid="voucher-history">
      {voucher.adjustments.map((adjustment) => (
        <li key={adjustment.id}>{adjustmentLine(adjustment)}</li>
      ))}
    </ul>
  );
}

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("customers.view");
  const { id } = await params;
  const detail = await getCustomerDetail(id);
  if (!detail) notFound();

  const canManage = session.permissionKeys.includes("customers.manage");
  const canAdjustVouchers = session.permissionKeys.includes("vouchers.void");
  const today = jakartaDate();
  const latestDate = latestExtensionDate(today);

  /** The extension date window for one voucher: after today and after its current expiry day, at
   * most three months out (the server checks again). Null when no day is left to choose. */
  function extensionWindow(voucher: CustomerVoucherRow): { min: string; max: string } | null {
    // The expiry's own day still works when the voucher ends before 23:59:59 WIB that day.
    const expiryDay = jakartaDate(voucher.expiresAt);
    const afterExpiry = endOfJakartaDay(expiryDay).getTime() > voucher.expiresAt.getTime() ? expiryDay : addCalendarDays(expiryDay, 1);
    const tomorrow = addCalendarDays(today, 1);
    const min = afterExpiry > tomorrow ? afterExpiry : tomorrow;
    return min <= latestDate ? { min, max: latestDate } : null;
  }

  function voucherActions(voucher: CustomerVoucherRow) {
    if (!canAdjustVouchers) return null;
    const extension = voucher.status === "active" || voucher.status === "expired" ? extensionWindow(voucher) : null;
    if (voucher.status !== "active" && !extension) return null;
    return (
      <div className="flex flex-wrap gap-2">
        {extension && <ExtendVoucherButton voucherId={voucher.id} label={voucher.cardOrderNo} minDate={extension.min} maxDate={extension.max} />}
        {voucher.status === "active" && <VoidVoucherButton voucherId={voucher.id} label={voucher.cardOrderNo} />}
      </div>
    );
  }

  const usedLine = (voucher: CustomerVoucherRow) =>
    voucher.usedOrder ? (
      <Link href={`/orders/${voucher.usedOrder.id}`} className="text-brand hover:underline">
        {voucher.usedOrder.orderNo}
      </Link>
    ) : (
      "-"
    );

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/customers"), { label: detail.name }]} />
      <PageHeader title={detail.name} description={`Pelanggan sejak ${formatDate(detail.createdAt)}`} />

      <div className="flex flex-col gap-8">
        <Section id="customer-profile" title="Profil">
          <Card className="p-4">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Email" testId="customer-email">
                {detail.email ? (
                  <span className="flex flex-wrap items-center gap-2 break-all">
                    {detail.email}
                    {detail.emailVerifiedAt && <Badge variant="success">Terverifikasi</Badge>}
                  </span>
                ) : (
                  "-"
                )}
              </Field>
              <Field label="Nomor HP" testId="customer-phone">
                {detail.phone ? (
                  <span className="flex flex-wrap items-center gap-2 tabular-nums">
                    {detail.phone}
                    {detail.phoneVerifiedAt && <Badge variant="success">Terverifikasi</Badge>}
                  </span>
                ) : (
                  "-"
                )}
              </Field>
              <Field label="Jenis">{CUSTOMER_TYPE_LABELS[detail.type] ?? detail.type}</Field>
              <Field label="Akun situs" testId="customer-account">
                {detail.account ? `Ya, masuk dengan ${detail.account.methods.map((method) => SIGN_IN_METHOD_LABELS[method]).join(" dan ")}` : "Tidak"}
              </Field>
              <Field label="Pesanan dihitung">{formatNumber(detail.orderCount)}</Field>
              <Field label="Total belanja">
                <span className="tabular-nums">{formatRupiah(detail.totalSpend)}</span>
              </Field>
            </dl>
            <p className="mt-4 text-sm text-neutral-600">Data diri diubah oleh pelanggan sendiri di halaman akun situs, tidak dari admin.</p>
          </Card>
        </Section>

        <Section
          id="customer-consent"
          title="Persetujuan"
          actions={canManage && detail.promoConsentAt ? <WithdrawPromoButton customerId={detail.id} /> : undefined}
        >
          <Card className="p-4">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Data pribadi (PDP)" testId="customer-pdp-consent">
                {detail.pdpConsentAt ? `Setuju sejak ${formatDateTime(detail.pdpConsentAt)}` : "Belum"}
              </Field>
              <Field label="Promo" testId="customer-promo-consent">
                {detail.promoConsentAt
                  ? `Setuju sejak ${formatDateTime(detail.promoConsentAt)}`
                  : detail.promoWithdrawnAt
                    ? `Ditarik pada ${formatDateTime(detail.promoWithdrawnAt)}`
                    : "Belum"}
              </Field>
            </dl>
          </Card>
        </Section>

        <Section
          id="customer-orders"
          title="Pesanan"
          description={detail.ordersTruncated ? `${DETAIL_ORDER_LIMIT} pesanan terbaru.` : "Termasuk pesanan yang tidak dihitung (belum dibayar, batal, retur)."}
        >
          {detail.orders.length === 0 ? (
            <EmptyState title="Belum ada pesanan" description="Pelanggan ini belum punya pesanan." />
          ) : (
            <>
              <CardList>
                {detail.orders.map((order) => (
                  <li key={order.id} data-testid="customer-order-card">
                    <Card className="flex flex-col gap-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/orders/${order.id}`} className="font-medium text-brand hover:underline">
                          {order.orderNo}
                        </Link>
                        <span className="tabular-nums">{formatRupiah(order.totalAmount)}</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={ORDER_STATUS_BADGE_VARIANT[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
                        {!order.counted && <Badge variant="neutral">Tidak dihitung</Badge>}
                      </div>
                      <p className="text-sm text-neutral-600">
                        {order.channelName} · {formatDate(order.orderDate)}
                      </p>
                    </Card>
                  </li>
                ))}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>No. pesanan</Th>
                  <Th>Tanggal</Th>
                  <Th>Kanal</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Total</Th>
                </TableHead>
                <tbody>
                  {detail.orders.map((order) => (
                    <Tr key={order.id} data-testid="customer-order-row">
                      <Td className="font-medium">
                        <Link href={`/orders/${order.id}`} className="text-brand hover:underline">
                          {order.orderNo}
                        </Link>
                      </Td>
                      <Td className="whitespace-nowrap text-neutral-700">{formatDate(order.orderDate)}</Td>
                      <Td className="text-neutral-700">{order.channelName}</Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          <Badge variant={ORDER_STATUS_BADGE_VARIANT[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
                          {!order.counted && <Badge variant="neutral">Tidak dihitung</Badge>}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums">{formatRupiah(order.totalAmount)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableContainer>
            </>
          )}
        </Section>

        <Section id="customer-vouchers" title="Voucher" description="Status sebenarnya: voucher aktif yang sudah lewat tanggalnya ditampilkan Kedaluwarsa.">
          {detail.vouchers.length === 0 ? (
            <EmptyState title="Belum ada voucher" description="Pelanggan ini belum mengklaim kartu terima kasih." />
          ) : (
            <>
              <CardList>
                {detail.vouchers.map((voucher) => (
                  <li key={voucher.id} data-testid="customer-voucher-card" data-voucher={voucher.cardOrderNo}>
                    <Card className="flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-neutral-900">Voucher dari {voucher.cardOrderNo}</p>
                          <Badge variant={VOUCHER_STATUS_BADGE[voucher.status]}>{VOUCHER_STATUS_LABELS[voucher.status]}</Badge>
                        </div>
                        <span className="font-semibold tabular-nums">{formatRupiah(voucher.amount)}</span>
                      </div>
                      <p className="text-sm text-neutral-600">
                        Terbit {formatDate(voucher.issuedAt)} · berlaku sampai {formatDateTime(voucher.expiresAt)}
                      </p>
                      {voucher.usedOrder && <p className="text-sm text-neutral-700">Dipakai di {usedLine(voucher)}</p>}
                      <VoucherHistory voucher={voucher} />
                      {voucherActions(voucher)}
                    </Card>
                  </li>
                ))}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>Voucher</Th>
                  <Th className="text-right">Nilai</Th>
                  <Th>Status</Th>
                  <Th>Terbit</Th>
                  <Th>Berlaku sampai</Th>
                  <Th>Dipakai di</Th>
                  <Th>Riwayat</Th>
                  {canAdjustVouchers && <Th>Aksi</Th>}
                </TableHead>
                <tbody>
                  {detail.vouchers.map((voucher) => (
                    <Tr key={voucher.id} data-testid="customer-voucher-row" data-voucher={voucher.cardOrderNo}>
                      <Td className="font-medium text-neutral-900">Dari {voucher.cardOrderNo}</Td>
                      <Td className="text-right tabular-nums">{formatRupiah(voucher.amount)}</Td>
                      <Td>
                        <Badge variant={VOUCHER_STATUS_BADGE[voucher.status]}>{VOUCHER_STATUS_LABELS[voucher.status]}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap text-neutral-700">{formatDate(voucher.issuedAt)}</Td>
                      <Td className="whitespace-nowrap text-neutral-700">{formatDateTime(voucher.expiresAt)}</Td>
                      <Td className="text-neutral-700">{usedLine(voucher)}</Td>
                      <Td className="max-w-80">{voucher.adjustments.length > 0 ? <VoucherHistory voucher={voucher} /> : "-"}</Td>
                      {canAdjustVouchers && <Td>{voucherActions(voucher)}</Td>}
                    </Tr>
                  ))}
                </tbody>
              </TableContainer>
            </>
          )}
        </Section>

        <Section id="customer-cards" title="Kartu terima kasih diklaim">
          {detail.claimedCards.length === 0 ? (
            <EmptyState title="Belum ada" description="Pelanggan ini belum mengklaim kartu terima kasih." />
          ) : (
            <ul className="flex flex-col gap-3">
              {detail.claimedCards.map((card) => (
                <li key={card.id} data-testid="customer-claimed-card">
                  <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-base text-neutral-900">
                        Kartu dari{" "}
                        <Link href={`/orders/${card.orderId}`} className="font-medium text-brand hover:underline">
                          {card.orderNo}
                        </Link>
                      </span>
                      <span className="text-sm text-neutral-600">
                        {card.claimedAt ? `Diklaim ${formatDateTime(card.claimedAt)}` : "Belum diklaim"} · batas klaim {formatDate(card.claimDeadline)}
                      </span>
                    </div>
                    <Badge variant="neutral">{THANK_YOU_CARD_STATUS_LABELS[card.status] ?? card.status}</Badge>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

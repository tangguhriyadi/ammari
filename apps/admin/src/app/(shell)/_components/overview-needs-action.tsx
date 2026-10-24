import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge, Card, Skeleton } from "@ammari/ui";
import { formatNumber, formatRupiah, formatShortDate } from "@ammari/ui/lib";
import { jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { formatCompactRupiah } from "@/lib/overview/format";
import {
  CHECKOUT_EXPIRY_SOON_MINUTES,
  getAttentionOrders,
  getAwaitingPaymentOrders,
  getLowStock,
  getToShipOrders,
  getUnpaidProduction,
  LATE_TO_SHIP_DAYS,
  STALE_MANUAL_PAYMENT_HOURS,
  type ActionOrderRow,
} from "@/lib/overview/needs-action";
import { getSupplierDebtSummary } from "@/lib/supplier-payments/supplier-balance";
import { PAYMENT_STATUS_LABELS } from "@/lib/supplier-payments/status";

/** Which blocks this viewer may see: each one is its own module's permission (§5, §6). */
export interface NeedsActionAccess {
  orders: boolean;
  /** packing.print_cards: Siap Kirim links to /packing instead of the order list. */
  packing: boolean;
  stock: boolean;
  /** inventory.view AND finance.view_profit: Utang pemasok is nothing but amounts. */
  supplierDebt: boolean;
  production: boolean;
  /** finance.view_profit: amounts on Produksi belum lunas. */
  profit: boolean;
}

export function hasAnyNeedsAction(access: NeedsActionAccess): boolean {
  return access.orders || access.stock || access.supplierDebt || access.production;
}

const SUPPLIER_DEBT_TOP = 3;

const timeFormatter = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jakarta" });

function BlockSkeleton() {
  return (
    <li className="px-4 py-3">
      <Skeleton className="h-6 rounded-md" />
    </li>
  );
}

export function OverviewNeedsActionSkeleton() {
  return <Skeleton className="h-96 rounded-lg" />;
}

function Block({
  title,
  count,
  countText,
  detail,
  href,
  hrefLabel = "Lihat semua",
  extraLinks,
  children,
  testId,
}: {
  title: string;
  count: number;
  /** Instead of the bare count (e.g. "Rp 12,5 jt"). */
  countText?: ReactNode;
  detail?: ReactNode;
  href: string;
  hrefLabel?: string;
  extraLinks?: ReactNode;
  children?: ReactNode;
  testId: string;
}) {
  const headingId = `${testId}-heading`;
  if (count === 0) {
    // Shown collapsed, so the owner sees it was checked (§5).
    return (
      <li className="flex min-h-11 items-center justify-between gap-3 px-4 py-2" data-testid={testId}>
        <h3 id={headingId} className="text-base font-medium text-neutral-900">
          {title}
        </h3>
        <span className="text-sm text-neutral-600" data-testid={`${testId}-count`}>
          Tidak ada
        </span>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="text-base font-semibold text-neutral-900">
          {title}
        </h3>
        <span className="shrink-0 text-lg font-semibold text-neutral-900 tabular-nums" data-testid={`${testId}-count`}>
          {countText ?? formatNumber(count)}
        </span>
      </div>
      {detail && <div className="flex flex-wrap gap-2 text-sm text-neutral-700">{detail}</div>}
      {children && <ul className="-mx-2 flex flex-col">{children}</ul>}
      <div className="flex flex-wrap gap-x-4">
        <Link href={href} className="inline-flex min-h-11 items-center gap-1 text-base font-medium text-brand underline-offset-2 hover:underline" data-testid={`${testId}-all`}>
          {hrefLabel}
          <ChevronRight aria-hidden="true" className="size-4" />
        </Link>
        {extraLinks}
      </div>
    </li>
  );
}

/** A full-width tap target of at least 44px (§8). */
function ItemLink({ href, children, aside }: { href: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-neutral-50">
        <span className="flex min-w-0 flex-col">{children}</span>
        <span className="flex shrink-0 items-center gap-2">
          {aside}
          <ChevronRight aria-hidden="true" className="size-4 text-neutral-500" />
        </span>
      </Link>
    </li>
  );
}

function OrderItem({ order, aside, note }: { order: ActionOrderRow; aside?: ReactNode; note?: string }) {
  return (
    <ItemLink href={`/orders/${order.id}`} aside={aside}>
      <span className="text-sm font-medium text-neutral-900 tabular-nums">{order.orderNo}</span>
      <span className="truncate text-sm text-neutral-600">
        {[order.buyerName ?? order.channelName, note ?? formatShortDate(order.orderDate)].join(", ")}
      </span>
    </ItemLink>
  );
}

async function AttentionBlock() {
  const { count, rows } = await getAttentionOrders();
  return (
    <Block title="Perlu dicek" count={count} href="/orders?status=perlu-dicek" testId="action-attention">
      {rows.map((order) => (
        <OrderItem key={order.id} order={order} />
      ))}
    </Block>
  );
}

async function ToShipBlock({ now, packing }: { now: Date; packing: boolean }) {
  const { count, lateCount, rows } = await getToShipOrders(now);
  return (
    <Block
      title="Siap Kirim"
      count={count}
      href={packing ? "/packing" : "/orders?status=to_ship"}
      hrefLabel={packing ? "Buka Packing" : "Lihat semua"}
      testId="action-to-ship"
      detail={
        lateCount > 0 ? (
          <Badge variant="danger" data-testid="action-to-ship-late">
            {formatNumber(lateCount)} lebih dari {LATE_TO_SHIP_DAYS} hari
          </Badge>
        ) : (
          <span>Semua dalam {LATE_TO_SHIP_DAYS} hari</span>
        )
      }
    >
      {rows.map((order) => (
        <OrderItem key={order.id} order={order} aside={order.isLate ? <Badge variant="danger">Terlambat</Badge> : undefined} />
      ))}
    </Block>
  );
}

async function AwaitingPaymentBlock({ now }: { now: Date }) {
  const { staleManualCount, expiringCheckoutCount, rows } = await getAwaitingPaymentOrders(now);
  const count = staleManualCount + expiringCheckoutCount;
  return (
    <Block
      title="Menunggu Bayar"
      count={count}
      href="/orders?status=awaiting_payment"
      testId="action-awaiting-payment"
      detail={
        <>
          {expiringCheckoutCount > 0 && (
            <Badge variant="warning">
              {formatNumber(expiringCheckoutCount)} checkout habis dalam {CHECKOUT_EXPIRY_SOON_MINUTES} menit
            </Badge>
          )}
          {staleManualCount > 0 && (
            <Badge>
              {formatNumber(staleManualCount)} manual lebih dari {STALE_MANUAL_PAYMENT_HOURS} jam
            </Badge>
          )}
        </>
      }
    >
      {rows.map((order) => (
        <OrderItem
          key={order.id}
          order={order}
          note={order.kind === "expiring_checkout" && order.paymentExpiresAt ? `batas bayar ${timeFormatter.format(order.paymentExpiresAt)} WIB` : undefined}
        />
      ))}
    </Block>
  );
}

async function LowStockBlock() {
  const { outCount, lowCount, rows } = await getLowStock();
  return (
    <Block
      title="Stok menipis"
      count={outCount + lowCount}
      href="/stock?low=1"
      testId="action-low-stock"
      detail={
        <>
          {outCount > 0 && <Badge variant="danger">{formatNumber(outCount)} habis</Badge>}
          {lowCount > 0 && <Badge variant="warning">{formatNumber(lowCount)} menipis</Badge>}
        </>
      }
    >
      {rows.map((row) => (
        <ItemLink
          key={row.sku}
          href={`/stock/${encodeURIComponent(row.sku)}`}
          aside={row.currentStock <= 0 ? <Badge variant="danger">Habis</Badge> : <Badge variant="warning">Menipis</Badge>}
        >
          <span className="truncate text-sm font-medium text-neutral-900">{row.productName}</span>
          <span className="text-sm text-neutral-600 tabular-nums">
            {row.colorName}, {row.size}: sisa {formatNumber(Math.max(row.currentStock, 0))}, minimal {formatNumber(row.minStockQty)}
          </span>
        </ItemLink>
      ))}
    </Block>
  );
}

async function SupplierDebtBlock() {
  const summary = await getSupplierDebtSummary(SUPPLIER_DEBT_TOP);
  return (
    <Block
      title="Utang pemasok"
      count={summary.suppliersOwed}
      countText={<span title={formatRupiah(summary.totalOutstanding)}>{formatCompactRupiah(summary.totalOutstanding)}</span>}
      href="/suppliers?balance=owed"
      testId="action-supplier-debt"
      detail={
        <span>
          Total utang {formatRupiah(summary.totalOutstanding)} ke {formatNumber(summary.suppliersOwed)} pemasok
        </span>
      }
    >
      {summary.top.map((row) => (
        <ItemLink key={row.supplierId} href={`/suppliers/${row.supplierId}`} aside={<span className="text-sm font-medium text-neutral-900 tabular-nums">{formatCompactRupiah(row.outstanding)}</span>}>
          <span className="truncate text-sm font-medium text-neutral-900">{row.supplierName}</span>
        </ItemLink>
      ))}
    </Block>
  );
}

async function UnpaidProductionBlock({ profit }: { profit: boolean }) {
  const { unpaidCount, partialCount, remainingTotal, rows } = await getUnpaidProduction({ canViewProfit: profit });
  return (
    <Block
      title="Produksi belum lunas"
      count={unpaidCount + partialCount}
      href={unpaidCount > 0 ? "/production?payment=unpaid" : "/production?payment=partial"}
      hrefLabel={unpaidCount > 0 ? "Lihat semua" : "Lihat DP"}
      extraLinks={
        unpaidCount > 0 && partialCount > 0 ? (
          <Link href="/production?payment=partial" className="inline-flex min-h-11 items-center gap-1 text-base font-medium text-brand underline-offset-2 hover:underline">
            Lihat DP
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
        ) : undefined
      }
      testId="action-production"
      detail={
        <>
          {unpaidCount > 0 && <Badge variant="danger">{formatNumber(unpaidCount)} belum bayar</Badge>}
          {partialCount > 0 && <Badge variant="warning">{formatNumber(partialCount)} DP</Badge>}
          {remainingTotal !== null && <span>Sisa tagihan {formatRupiah(remainingTotal)}</span>}
        </>
      }
    >
      {rows.map((row) => (
        <ItemLink
          key={row.id}
          href={`/production/${row.id}`}
          aside={
            <>
              {row.remaining !== null && <span className="text-sm text-neutral-700 tabular-nums">{formatCompactRupiah(row.remaining)}</span>}
              <Badge variant={row.status === "unpaid" ? "danger" : "warning"}>{PAYMENT_STATUS_LABELS[row.status]}</Badge>
            </>
          }
        >
          <span className="text-sm font-medium text-neutral-900 tabular-nums">{row.batchNo}</span>
          <span className="text-sm text-neutral-600">{formatShortDate(jakartaMidnight(row.producedAt))}</span>
        </ItemLink>
      ))}
    </Block>
  );
}

/**
 * "Perlu tindakan" (§5): not tied to the period. Each block renders only for a viewer holding its
 * module's permission, and only then queries; amounts only with finance.view_profit (D9).
 */
export function OverviewNeedsAction({ access, now, className }: { access: NeedsActionAccess; now: Date; className?: string }) {
  return (
    <section aria-labelledby="overview-actions-heading" className={`flex flex-col gap-3 ${className ?? ""}`} data-testid="overview-needs-action">
      <h2 id="overview-actions-heading" className="text-lg font-semibold text-neutral-900">
        Perlu tindakan
      </h2>
      <Card className="p-0">
        <ul className="flex flex-col divide-y divide-neutral-200">
          {/* One boundary per block: a slow query holds back only its own row. */}
          {access.orders && (
            <>
              <Suspense fallback={<BlockSkeleton />}>
                <AttentionBlock />
              </Suspense>
              <Suspense fallback={<BlockSkeleton />}>
                <ToShipBlock now={now} packing={access.packing} />
              </Suspense>
              <Suspense fallback={<BlockSkeleton />}>
                <AwaitingPaymentBlock now={now} />
              </Suspense>
            </>
          )}
          {access.stock && (
            <Suspense fallback={<BlockSkeleton />}>
              <LowStockBlock />
            </Suspense>
          )}
          {access.supplierDebt && (
            <Suspense fallback={<BlockSkeleton />}>
              <SupplierDebtBlock />
            </Suspense>
          )}
          {access.production && (
            <Suspense fallback={<BlockSkeleton />}>
              <UnpaidProductionBlock profit={access.profit} />
            </Suspense>
          )}
        </ul>
      </Card>
    </section>
  );
}

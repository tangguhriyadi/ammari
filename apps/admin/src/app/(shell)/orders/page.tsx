import Link from "next/link";
import { Breadcrumb, Button, Input, FilterTabs, Pagination, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listOrders } from "@/lib/orders/queries";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import type { OrderStatus } from "@ammari/db/schema";
import { OrderList } from "./_components/order-list";

const STATUS_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  ...(Object.entries(ORDER_STATUS_LABELS) as [OrderStatus, string][]).map(([value, label]) => ({ label, value })),
] as const;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("orders.view");
  const { q, status: rawStatus, page, perPage } = await searchParams;
  const status = (Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]).includes(rawStatus as OrderStatus)
    ? (rawStatus as OrderStatus)
    : undefined;
  const canManage = session.permissionKeys.includes("orders.manage");

  const { rows, pagination } = await listOrders({ status, q }, page, perPage);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/orders")} />
      <PageHeader
        title="Pesanan"
        description="Daftar pesanan dari semua kanal penjualan."
        actions={
          canManage ? (
            <Link href="/orders/new">
              <Button>Catat pesanan</Button>
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3">
        <FilterTabs basePath="/orders" paramName="status" options={STATUS_FILTER_OPTIONS} activeValue={status} aria-label="Filter status pesanan" />
        <form method="GET">
          {rawStatus && <input type="hidden" name="status" value={rawStatus} />}
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nomor pesanan atau nama pelanggan..." aria-label="Cari pesanan" />
        </form>
        <OrderList rows={rows} />
      </div>
      <Pagination pagination={pagination} basePath="/orders" searchParams={{ q, status: rawStatus, perPage }} itemLabel="pesanan" />
    </>
  );
}

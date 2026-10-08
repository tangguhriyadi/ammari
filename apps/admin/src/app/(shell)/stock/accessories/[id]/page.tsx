import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Badge, Breadcrumb } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getAccessoryBalance, getAccessoryById, listAccessoryLedger } from "@/lib/inventory/accessories";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { AccessoryLedger } from "../../_components/accessory-ledger";
import { AccessoryStockControls } from "../../_components/accessory-stock-controls";

export default async function AccessoryStockDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;
  const { page, perPage } = await searchParams;

  const accessory = await getAccessoryById(id);
  if (!accessory) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const [balance, { rows, pagination }] = await Promise.all([
    getAccessoryBalance(id),
    listAccessoryLedger(id, page, perPage),
  ]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Aksesoris", href: "/stock/accessories" }, { label: accessory.name }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader
          title={accessory.name}
          description={[accessory.size === "ALLSIZE" ? "Polos" : accessory.size, accessory.sizeGroup].filter(Boolean).join(" · ") || undefined}
        />
        {!accessory.isActive && <Badge variant="neutral">Nonaktif</Badge>}
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="text-2xl font-semibold tabular-nums text-neutral-900">{formatNumber(balance.qty)} pcs</span>
        {canManage && <AccessoryStockControls accessoryId={accessory.id} />}
        <Link href={`/accessories/${id}`} className="text-base font-medium text-brand hover:underline">
          Lihat data master →
        </Link>
      </div>
      <AccessoryLedger
        rows={rows}
        pagination={pagination}
        basePath={`/stock/accessories/${id}`}
        searchParams={{ perPage }}
        canViewProfit={canViewProfit}
      />
    </>
  );
}

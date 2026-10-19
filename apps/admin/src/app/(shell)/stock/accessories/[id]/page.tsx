import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/purchases/queries";
import { PageHeader, Badge, Breadcrumb } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getAccessoryBalance, getAccessoryById, listAccessoryLedger } from "@/lib/inventory/accessories";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getDefectBalance, listItemDefectMovements, stripItemDefectAmounts } from "@/lib/defects/queries";
import { ItemDefectSection } from "../../_components/item-defect-section";
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
  // A malformed id would otherwise reach Postgres as a uuid cast error (a 500), not a 404.
  if (!isUuid(id)) notFound();
  const { page, perPage } = await searchParams;

  const accessory = await getAccessoryById(id);
  if (!accessory) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const [balance, { rows, pagination }, defectBalance, defectRows] = await Promise.all([
    getAccessoryBalance(id),
    listAccessoryLedger(id, page, perPage),
    getDefectBalance({ kind: "accessory", accessoryId: id }),
    listItemDefectMovements({ kind: "accessory", accessoryId: id }),
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
      <ItemDefectSection
        kind="accessory"
        balance={{ qty: defectBalance.qty, valueAmount: canViewProfit ? defectBalance.valueAmount : null }}
        rows={stripItemDefectAmounts(defectRows, canViewProfit)}
        canOpenPurchase
        canOpenBatch={session.permissionKeys.includes("production.manage")}
      />
    </>
  );
}

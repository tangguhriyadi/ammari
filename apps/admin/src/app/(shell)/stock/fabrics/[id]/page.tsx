import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/purchases/queries";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getFabricById } from "@/lib/products/fabric-queries";
import { getFabricBalance, isAdjustableBucket, listFabricColorBalances, listFabricStockLedger, parseFabricColorFilter } from "@/lib/inventory/fabric-stock";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getDefectBalance, getFabricDefectQtyByColor, listItemDefectMovements, stripItemDefectAmounts } from "@/lib/defects/queries";
import { ItemDefectSection } from "../../_components/item-defect-section";
import { FabricLedger } from "../../_components/fabric-ledger";
import { FabricStockControls } from "../../_components/fabric-stock-controls";
import { FabricColorBalances, FabricLedgerColorFilter, toFabricColorStock } from "../../_components/fabric-color-stock";

export default async function FabricStockDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; perPage?: string; warna?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;
  // A malformed id would otherwise reach Postgres as a uuid cast error (a 500), not a 404.
  if (!isUuid(id)) notFound();
  const { page, perPage, warna } = await searchParams;
  const colorFilter = parseFabricColorFilter(warna);

  const fabric = await getFabricById(id);
  if (!fabric) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");
  // /fabrics/[id] is gated by products.manage, a different permission domain from this page's
  // own inventory.view — see the matching comment where fabrics/[id] itself checks inventory.view
  // before linking to THIS page. Linking there unconditionally would dangle for a session that
  // holds inventory.view/inventory.manage but not products.manage.
  const canViewMaster = session.permissionKeys.includes("products.manage");

  const [balance, colorBalances, { rows, pagination }, defectBalance, defectRows, defectColors] = await Promise.all([
    getFabricBalance(id),
    listFabricColorBalances(id),
    listFabricStockLedger(id, page, perPage, undefined, { color: colorFilter }),
    getDefectBalance({ kind: "fabric", fabricId: id }),
    listItemDefectMovements({ kind: "fabric", fabricId: id }),
    getFabricDefectQtyByColor(id),
  ]);

  const colorStock = toFabricColorStock(colorBalances, canViewProfit);
  const fabricHasActiveColors = colorBalances.some((row) => row.fabricColorId !== null && row.isActive);
  // "Sesuaikan stok" colour options: the same rule recordFabricAdjustment enforces. A fabric with
  // no colours and no history yet still gets its "Tanpa warna" option.
  const adjustOptions = colorBalances
    .filter((row) => isAdjustableBucket(row, fabricHasActiveColors))
    .map((row) => ({ fabricColorId: row.fabricColorId, name: row.name, isActive: row.isActive, qty: row.qty }));
  if (!fabricHasActiveColors && !adjustOptions.some((option) => option.fabricColorId === null)) {
    adjustOptions.push({ fabricColorId: null, name: null, isActive: true, qty: 0 });
  }
  const basePath = `/stock/fabrics/${id}`;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Kain", href: "/stock/fabrics" }, { label: fabric.name }]} />
      <PageHeader title={fabric.name} description={fabric.supplier ?? undefined} />
      <FabricColorBalances rows={colorStock} total={{ qty: balance.qty, valueAmount: canViewProfit ? balance.valueAmount : null }} />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {canManage && <FabricStockControls fabricId={fabric.id} colorOptions={adjustOptions} requireColor={fabricHasActiveColors} />}
        {canViewMaster && (
          <Link href={`/fabrics/${id}`} className="inline-flex min-h-11 items-center text-base font-medium text-brand hover:underline">
            Lihat data master →
          </Link>
        )}
      </div>
      <h2 className="mb-3 text-lg font-semibold text-neutral-900">Riwayat stok</h2>
      <FabricLedgerColorFilter
        basePath={basePath}
        rows={colorStock}
        active={colorFilter}
        perPage={perPage}
      />
      <FabricLedger
        rows={rows}
        pagination={pagination}
        basePath={basePath}
        searchParams={{ perPage, warna: colorFilter === undefined ? undefined : (colorFilter ?? "tanpa") }}
        canViewProfit={canViewProfit}
        filtered={colorFilter !== undefined}
      />
      <ItemDefectSection
        kind="fabric"
        balance={{ qty: defectBalance.qty, valueAmount: canViewProfit ? defectBalance.valueAmount : null }}
        rows={stripItemDefectAmounts(defectRows, canViewProfit)}
        canOpenPurchase
        canOpenBatch={session.permissionKeys.includes("production.manage")}
        colors={defectColors}
      />
    </>
  );
}

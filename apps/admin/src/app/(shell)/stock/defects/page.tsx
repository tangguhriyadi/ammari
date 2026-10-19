import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requireAnyPermission } from "@/lib/auth/require-any-permission";
import { listDefectStockMaterials, listDefectStockSkus } from "@/lib/defects/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { StockTypeTabs } from "../_components/stock-type-tabs";
import { DefectMaterialList, DefectSkuList } from "../_components/defect-stock-list";

/** "Cacat" (docs/plans/suppliers-goods-receipt.md §7, S5): every item with defect stock, across all
 * three kinds. Defect stock is never sellable, never ordered, never packed and never counted as
 * sellable (D14); this page is one of the few places that deliberately reads it. Opens with either
 * stock.view or inventory.view; each section is gated by its own key, and its query never runs for
 * a session without it. Value only with finance.view_profit, stripped server-side. */
export default async function DefectStockPage() {
  const session = await requireAnyPermission(["stock.view", "inventory.view"]);
  const canViewFinishedGoods = session.permissionKeys.includes("stock.view");
  const canViewRawMaterials = session.permissionKeys.includes("inventory.view");
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  const [skuRows, materialRows] = await Promise.all([
    canViewFinishedGoods ? listDefectStockSkus() : Promise.resolve([]),
    canViewRawMaterials ? listDefectStockMaterials() : Promise.resolve([]),
  ]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Cacat" }]} />
      <PageHeader title="Stok barang cacat" description="Barang yang diterima dalam keadaan cacat. Tidak bisa dijual dan tidak dihitung sebagai stok." />
      <div className="flex flex-col gap-3">
        <StockTypeTabs active="Cacat" canViewFinishedGoods={canViewFinishedGoods} canViewRawMaterials={canViewRawMaterials} />
        {canViewFinishedGoods && (
          <section aria-labelledby="defect-sku-heading" className="flex flex-col gap-3">
            <h2 id="defect-sku-heading" className="text-lg font-semibold text-neutral-900">
              Barang jadi
            </h2>
            <DefectSkuList rows={skuRows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))} />
          </section>
        )}
        {canViewRawMaterials && (
          <section aria-labelledby="defect-material-heading" className="mt-3 flex flex-col gap-3">
            <h2 id="defect-material-heading" className="text-lg font-semibold text-neutral-900">
              Kain dan aksesoris
            </h2>
            <DefectMaterialList rows={materialRows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))} />
          </section>
        )}
      </div>
    </>
  );
}

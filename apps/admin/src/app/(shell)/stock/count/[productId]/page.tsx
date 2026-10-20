import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getDefectQtyBySku } from "@/lib/defects/queries";
import { isUuid } from "@/lib/purchases/queries";
import { listUnreceivedBatchesForProduct } from "@/lib/receipts/production";
import { getProductNameAndSkus, getReservedQtyBySku, listProductSkusForCount } from "@/lib/stock/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { StockCountForm } from "../../_components/stock-count-form";
import { UnreceivedBatchesWarning } from "../../_components/unreceived-batches-warning";

export default async function StockCountPage({ params }: { params: Promise<{ productId: string }> }) {
  const session = await requirePermission("stock.adjust");
  const { productId } = await params;
  if (!isUuid(productId)) notFound();

  const product = await getProductNameAndSkus(productId);
  if (!product) notFound();
  const [skus, unreceivedBatches] = await Promise.all([listProductSkusForCount(productId), listUnreceivedBatchesForProduct(productId)]);
  // Read-only, per SKU (S5): the defect bin sits in the same house, so each row shows how many
  // defective pcs exist for it. Never part of "Sistem" and never submitted with the count.
  const skuIds = skus.map((row) => row.sku);
  const [defectQty, reservedQty] = await Promise.all([getDefectQtyBySku(skuIds), getReservedQtyBySku(skuIds)]);
  const defectQtyBySku = Object.fromEntries(defectQty);
  // docs/plans/cart-checkout.md §7: pieces held for unpaid web orders are still on the shelf and
  // still in "Sistem", so they are counted like any other piece. Shown only while a hold exists.
  const reservedQtyBySku = Object.fromEntries(reservedQty);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Barang jadi", href: "/stock" }, { label: `Hitung stok: ${product.name}` }]} />
      <PageHeader title={`Hitung stok: ${product.name}`} description="Masukkan jumlah fisik untuk setiap SKU yang berbeda dari sistem." />
      <div className="mb-4 flex flex-col gap-3">
        <UnreceivedBatchesWarning batches={unreceivedBatches} canOpenBatches={session.permissionKeys.includes("production.manage")} />
        {/* Standing instruction (S4): the defect bin sits in the same house. Each SKU's defect
            quantity is shown read-only on its row (S5). */}
        <p className="text-base font-medium text-neutral-900">Jangan hitung barang cacat, hitung hanya barang yang bisa dijual.</p>
        {reservedQty.size > 0 && (
          <p className="text-base text-neutral-900" data-testid="count-reserved-note">
            Ada barang yang sedang dipesan dan menunggu pembayaran. Barangnya masih di rak, jadi tetap ikut dihitung.
          </p>
        )}
      </div>
      <StockCountForm productId={productId} skus={skus} defectQtyBySku={defectQtyBySku} reservedQtyBySku={reservedQtyBySku} />
    </>
  );
}

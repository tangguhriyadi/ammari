import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import {
  getFabricById,
  getFabricColorUsageCounts,
  getFabricUsageCount,
  listFabricColors,
} from "@/lib/products/fabric-queries";
import { getFabricBalance, listFabricColorBalances } from "@/lib/inventory/fabric-stock";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FabricForm } from "../_components/fabric-form";
import { FabricColorsSection } from "../_components/fabric-colors-section";
import { FabricColorBalances, toFabricColorStock } from "../../stock/_components/fabric-color-stock";

export default async function BahanEditPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("products.manage");
  const { id } = await params;
  const fabric = await getFabricById(id);
  if (!fabric) notFound();

  // Stock (qty/avg cost) is a separate permission domain (inventory.*) from this page's own
  // products.manage gate — a products.manage-only session simply doesn't see this block, same
  // "viewing requires inventory.view" rule the /stock and /purchases pages enforce.
  const canViewStock = session.permissionKeys.includes("inventory.view");
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  // Independent reads in parallel; the per-color usage counts are one grouped query
  // (docs/plans/admin-performance.md).
  const [productCount, [colors, usageCounts], balance, colorBalances] = await Promise.all([
    getFabricUsageCount(id),
    listFabricColors(id).then(async (colors) => [colors, await getFabricColorUsageCounts(colors.map((color) => color.id))] as const),
    canViewStock ? getFabricBalance(id) : Promise.resolve(null),
    canViewStock ? listFabricColorBalances(id) : Promise.resolve(null),
  ]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/fabrics"), { label: fabric.name }]} />
      <PageHeader title={fabric.name} />
      {balance && colorBalances && (
        <>
          <h2 className="mb-3 text-lg font-semibold text-neutral-900">Stok</h2>
          <FabricColorBalances
            rows={toFabricColorStock(colorBalances, canViewProfit)}
            total={{ qty: balance.qty, valueAmount: canViewProfit ? balance.valueAmount : null }}
            footer={
              <Link
                href={`/stock/fabrics/${id}`}
                className="inline-flex min-h-11 items-center self-start text-base font-medium text-brand hover:underline"
              >
                Lihat riwayat stok →
              </Link>
            }
          />
        </>
      )}
      <FabricForm
        fabricId={fabric.id}
        productCount={productCount}
        initialValues={{
          name: fabric.name,
          supplier: fabric.supplier ?? "",
          composition: fabric.composition ?? "",
          careInstructions: fabric.careInstructions ?? "",
          notes: fabric.notes ?? "",
          priceAmount: fabric.priceAmount != null ? String(fabric.priceAmount) : "",
          priceUnit: fabric.priceUnit,
        }}
      />

      <h2 className="mt-8 mb-4 text-lg font-semibold text-neutral-900">Warna</h2>
      <FabricColorsSection
        fabricId={fabric.id}
        colors={colors.map((color) => ({
          id: color.id,
          name: color.name,
          supplierColorCode: color.supplierColorCode,
          hex: color.hex,
          isActive: color.isActive,
        }))}
        usageCounts={usageCounts}
      />
    </>
  );
}

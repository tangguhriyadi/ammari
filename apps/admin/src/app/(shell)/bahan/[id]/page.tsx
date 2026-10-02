import { notFound } from "next/navigation";
import { PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import {
  getFabricById,
  getFabricColorUsageCount,
  getFabricUsageCount,
  listFabricColors,
} from "@/lib/products/fabric-queries";
import { FabricForm } from "../_components/fabric-form";
import { FabricColorsSection } from "../_components/fabric-colors-section";

export default async function BahanEditPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("products.manage");
  const { id } = await params;
  const fabric = await getFabricById(id);
  if (!fabric) notFound();

  const [productCount, colors] = await Promise.all([getFabricUsageCount(id), listFabricColors(id)]);
  const usageCounts: Record<string, number> = {};
  for (const color of colors) {
    usageCounts[color.id] = await getFabricColorUsageCount(color.id);
  }

  return (
    <>
      <PageHeader title={fabric.name} />
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

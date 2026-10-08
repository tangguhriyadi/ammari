import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, Button } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getProductDetail, getCurrentCostAssumption } from "@/lib/products/queries";
import { listFabricColors, listFabricsWithUsage } from "@/lib/products/fabric-queries";
import { listProductColorGroups, listProductImages } from "@/lib/products/image-queries";
import { calculateBatasHpp } from "@/lib/products/batas-hpp";
import { ProductForm } from "../_components/product-form";
import { VariantBuilder } from "../_components/variant-builder";
import { BatasHppCard } from "../_components/batas-hpp-card";
import { ProductPhotosSection } from "../_components/product-photos-section";
import { ProductThumbnail } from "../_components/product-thumbnail";

export default async function ProdukDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("products.manage");
  const { id } = await params;
  const detail = await getProductDetail(id);
  if (!detail) notFound();
  const { product, variants } = detail;

  const { rows: fabrics } = await listFabricsWithUsage(undefined, undefined);
  const availableColors = await listFabricColors(product.fabricId, { activeOnly: true });
  const colorGroups = await listProductColorGroups(product.id);
  const images = await listProductImages(product.id);

  // Never computed at all for a session without finance.view_profit — ProductBatasHpp below
  // (which runs the actual cost_assumptions query + calculation) is simply never rendered in
  // that case, so the number can't be sent to the client either way, not just hidden by CSS.
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canAdjustStock = session.permissionKeys.includes("stock.adjust");
  const thumbnailUrl = images.find((image) => image.id === product.thumbnailImageId)?.urls[400] ?? null;

  return (
    <>
      <div className="flex items-start gap-4">
        <ProductThumbnail url={thumbnailUrl} className="size-16 shrink-0 sm:size-20" />
        <div className="flex-1">
          <PageHeader
            title={product.name}
            actions={
              canAdjustStock && (
                <Link href={`/stock/count/${product.id}`}>
                  <Button variant="secondary">Hitung stok</Button>
                </Link>
              )
            }
          />
        </div>
      </div>
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex-1">
          <ProductForm
            productId={product.id}
            fabrics={fabrics}
            hasVariants={variants.length > 0}
            initialValues={{
              name: product.name,
              code: product.code,
              slug: product.slug,
              fabricId: product.fabricId,
              closure: product.closure,
              sizeMode: product.sizeMode,
              basePrice: String(product.basePrice),
              description: product.description ?? "",
              isActive: product.isActive,
            }}
          />
        </div>
        {canViewProfit && (
          <div className="w-full lg:w-72">
            <ProductBatasHpp basePrice={product.basePrice} />
          </div>
        )}
      </div>

      <h2 className="mt-8 mb-4 text-lg font-semibold text-neutral-900">Varian</h2>
      <VariantBuilder
        productId={product.id}
        fabricId={product.fabricId}
        sizeMode={product.sizeMode}
        basePrice={product.basePrice}
        availableColors={availableColors.map((color) => ({ id: color.id, name: color.name, hex: color.hex }))}
        variants={variants.map((variant) => ({
          sku: variant.sku,
          colorName: variant.colorName,
          colorHex: variant.colorHex,
          size: variant.size,
          priceOverrideAmount: variant.priceOverrideAmount,
          minStockQty: variant.minStockQty,
          isActive: variant.isActive,
        }))}
      />

      <div className="mt-8">
        <ProductPhotosSection
          productId={product.id}
          thumbnailImageId={product.thumbnailImageId}
          colorGroups={colorGroups}
          images={images}
        />
      </div>
    </>
  );
}

async function ProductBatasHpp({ basePrice }: { basePrice: number }) {
  const costAssumption = await getCurrentCostAssumption();
  if (!costAssumption) return null;
  const batasHpp = calculateBatasHpp(basePrice, costAssumption);
  return <BatasHppCard batasHpp={batasHpp} />;
}

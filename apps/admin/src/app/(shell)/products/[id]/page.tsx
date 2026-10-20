import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, Button, Breadcrumb } from "@ammari/ui";
import type { ProductHighlightKey } from "@ammari/db/highlights";
import { requireAnyPermission } from "@/lib/auth/require-any-permission";
import { getProductDetail, getCurrentCostAssumption } from "@/lib/products/queries";
import { listFabricColors, listAllFabricsWithUsage } from "@/lib/products/fabric-queries";
import { listProductColorGroups, listProductImages } from "@/lib/products/image-queries";
import { calculateBatasHpp } from "@/lib/products/batas-hpp";
import { listActiveAccessories, listDistinctSizeGroups } from "@/lib/inventory/accessories";
import { listRecipeForProduct } from "@/lib/inventory/recipes";
import { listSizeCharts } from "@/lib/content/size-charts";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductForm } from "../_components/product-form";
import { VariantBuilder } from "../_components/variant-builder";
import { BatasHppCard } from "../_components/batas-hpp-card";
import { ProductPhotosSection } from "../_components/product-photos-section";
import { ProductThumbnail } from "../_components/product-thumbnail";
import { AccessoryRecipeSection } from "../_components/accessory-recipe-section";
import { StorefrontSection } from "../_components/storefront-section";

export default async function ProdukDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Either permission is enough to reach this page at all — which SECTIONS render below is then
  // gated per-section (canManageProducts/canManageContent), not by this page-level check alone.
  // See docs/plans/storefront-cms.md's "Admin UX"/"Security": products.manage and content.manage
  // are two independent gates on the same form, each controlling its own fields only.
  const session = await requireAnyPermission(["products.manage", "content.manage"]);
  const canManageProducts = session.permissionKeys.includes("products.manage");
  const canManageContent = session.permissionKeys.includes("content.manage");

  const { id } = await params;
  const detail = await getProductDetail(id);
  if (!detail) notFound();
  const { product, variants } = detail;

  const fabrics = canManageProducts ? await listAllFabricsWithUsage() : [];
  const availableColors = canManageProducts ? await listFabricColors(product.fabricId, { activeOnly: true }) : [];
  const colorGroups = canManageProducts ? await listProductColorGroups(product.id) : [];
  const images = await listProductImages(product.id);
  const recipeRows = canManageProducts ? await listRecipeForProduct(product.id) : [];
  const activeAccessories = canManageProducts ? await listActiveAccessories() : [];
  const distinctSizeGroups = canManageProducts ? await listDistinctSizeGroups() : [];
  const sizeCharts = canManageContent ? await listSizeCharts() : [];

  // Never computed at all for a session without finance.view_profit — ProductBatasHpp below
  // (which runs the actual cost_assumptions query + calculation) is simply never rendered in
  // that case, so the number can't be sent to the client either way, not just hidden by CSS.
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canAdjustStock = session.permissionKeys.includes("stock.adjust");
  const thumbnailUrl = images.find((image) => image.id === product.thumbnailImageId)?.urls[400] ?? null;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/products"), { label: product.name }]} />
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
      {canManageProducts && (
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
                // Cast, not re-validated here: the DB's own CHECK constraints (migration 0018)
                // already guarantee every stored element is one of PRODUCT_HIGHLIGHT_KEYS.
                highlights: product.highlights as ProductHighlightKey[],
              }}
            />
          </div>
          {canViewProfit && (
            <div className="w-full lg:w-72">
              <ProductBatasHpp basePrice={product.basePrice} />
            </div>
          )}
        </div>
      )}

      {canManageProducts && (
        <>
          <h2 className="mt-8 mb-4 text-lg font-semibold text-neutral-900">Varian</h2>
          <VariantBuilder
            productId={product.id}
            fabricId={product.fabricId}
            sizeMode={product.sizeMode}
            basePrice={product.basePrice}
            availableColors={availableColors.map((color) => ({ id: color.id, name: color.name, hex: color.hex }))}
            variants={variants.map((variant) => ({
              sku: variant.sku,
              fabricColorId: variant.fabricColorId,
              colorName: variant.colorName,
              colorHex: variant.colorHex,
              size: variant.size,
              priceOverrideAmount: variant.priceOverrideAmount,
              minStockQty: variant.minStockQty,
              isActive: variant.isActive,
            }))}
            colorIdsMissingPhotos={colorGroups.filter((group) => group.imageCount === 0).map((group) => group.fabricColorId)}
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
      )}

      {canManageContent && (
        <div className="mt-8">
          <StorefrontSection
            productId={product.id}
            sizeMode={product.sizeMode}
            isActive={product.isActive}
            photoCount={images.length}
            canOpenPhotos={canManageProducts}
            initialValues={{
              isPublishedOnStorefront: product.isPublishedOnStorefront,
              storefrontDescriptionHtml: product.storefrontDescription ?? "",
              allsizeFitNote: product.allsizeFitNote ?? "",
              sizeChartId: product.sizeChartId,
            }}
            sizeCharts={sizeCharts}
          />
        </div>
      )}

      {canManageProducts && (
        <div className="mt-8">
          <AccessoryRecipeSection
            productId={product.id}
            initialRows={recipeRows.map((row) => ({
              id: row.id,
              clientKey: row.id,
              target: row.accessoryId !== null ? ("accessory" as const) : ("sizeGroup" as const),
              accessoryId: row.accessoryId ?? "",
              sizeGroup: row.sizeGroup ?? "",
              qtyPerPcs: String(row.qtyPerPcs),
            }))}
            activeAccessories={activeAccessories.map((accessory) => ({ id: accessory.id, name: accessory.name, size: accessory.size }))}
            distinctSizeGroups={distinctSizeGroups}
          />
        </div>
      )}
    </>
  );
}

async function ProductBatasHpp({ basePrice }: { basePrice: number }) {
  const costAssumption = await getCurrentCostAssumption();
  if (!costAssumption) return null;
  const batasHpp = calculateBatasHpp(basePrice, costAssumption);
  return <BatasHppCard batasHpp={batasHpp} />;
}

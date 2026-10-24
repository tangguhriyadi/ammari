import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader, Button, Breadcrumb } from "@ammari/ui";
import type { ProductHighlightKey } from "@ammari/db/highlights";
import { discountStatus } from "@ammari/db/pricing";
import { requireAnyPermission } from "@/lib/auth/require-any-permission";
import { requirePermission } from "@/lib/auth/require-permission";
import { getProductDetail, getCurrentCostAssumption } from "@/lib/products/queries";
import { listFabricColors, listAllFabricsWithUsage } from "@/lib/products/fabric-queries";
import { listActiveProductTypeOptions } from "@/lib/product-types/queries";
import { listProductColorGroups, listProductImages } from "@/lib/products/image-queries";
import { calculateBatasHpp } from "@/lib/products/batas-hpp";
import { listActiveAccessories, listDistinctSizeGroups } from "@/lib/inventory/accessories";
import { listRecipeForProduct } from "@/lib/inventory/recipes";
import { listSizeCharts } from "@/lib/content/size-charts";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { formatRupiahInput, utcToJakartaLocal } from "@/lib/products/discount";
import { PHOTO_SECTION_ID } from "@/lib/products/photo-messages";
import {
  productStepHref,
  resolveCreateStep,
  resolveEditStep,
  type ProductStepKey,
  type ProductStepperMode,
} from "@/lib/products/stepper";
import { ProductForm } from "./product-form";
import { VariantBuilder } from "./variant-builder";
import { BatasHppCard } from "./batas-hpp-card";
import { ProductPhotosSection } from "./product-photos-section";
import { ProductThumbnail } from "./product-thumbnail";
import { AccessoryRecipeSection } from "./accessory-recipe-section";
import { StorefrontSection } from "./storefront-section";
import { DiscountSection } from "./discount-section";
import { ProductStepper } from "./product-stepper";

type SearchParams = Record<string, string | string[] | undefined>;

/** The product page, one step at a time (docs/plans/product-stepper.md): edit mode at
 * `/products/[id]?step=`, create mode for a saved draft at `/products/[id]/setup?step=&reached=`.
 * Only the open step's sections render, and only their data is loaded. */
export async function ProductStepPage({ id, mode, searchParams }: { id: string; mode: ProductStepperMode; searchParams: SearchParams }) {
  // Edit: either permission is enough to reach this page at all — which SECTIONS render below is
  // then gated per-section (canManageProducts/canManageContent), not by this page-level check
  // alone. See docs/plans/storefront-cms.md's "Admin UX"/"Security": products.manage and
  // content.manage are two independent gates on the same form, each controlling its own fields
  // only. Create mode is the products.manage flow of adding a product.
  const session = mode === "create" ? await requirePermission("products.manage") : await requireAnyPermission(["products.manage", "content.manage"]);
  const canManageProducts = session.permissionKeys.includes("products.manage");
  const canManageContent = session.permissionKeys.includes("content.manage");

  const detail = await getProductDetail(id);
  if (!detail) notFound();
  const { product, productType, variants } = detail;
  const hasVariants = variants.length > 0;

  let current: ProductStepKey;
  let reached: ProductStepKey = "info";
  if (mode === "create") {
    const resolved = resolveCreateStep(searchParams.step, searchParams.reached, { hasVariants });
    if (resolved.changed) redirect(productStepHref(product.id, resolved.step, "create", resolved.reached));
    current = resolved.step;
    reached = resolved.reached;
  } else {
    current = resolveEditStep(searchParams.step, { canManageProducts });
  }

  // Edit mode's "done" mark for Aksesoris needs the recipe on every step, not only its own.
  const needsRecipe = canManageProducts && (mode === "edit" || current === "aksesoris");
  const [images, recipeRows] = await Promise.all([
    listProductImages(product.id),
    needsRecipe ? listRecipeForProduct(product.id) : Promise.resolve([]),
  ]);

  // Never computed at all for a session without finance.view_profit — ProductBatasHpp below
  // (which runs the actual cost_assumptions query + calculation) is simply never rendered in
  // that case, so the number can't be sent to the client either way, not just hidden by CSS.
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canAdjustStock = session.permissionKeys.includes("stock.adjust");
  const thumbnailUrl = images.find((image) => image.id === product.thumbnailImageId)?.urls[400] ?? null;

  const stepper =
    mode === "create"
      ? ({ mode: "create", productId: product.id, reached } as const)
      : ({
          mode: "edit",
          productId: product.id,
          completion: {
            hasVariants,
            hasPhotos: images.length > 0,
            isPublished: product.isPublishedOnStorefront,
            hasRecipe: recipeRows.length > 0,
          },
        } as const);

  async function stepContent() {
    switch (current) {
      case "info": {
        if (!canManageProducts) return <NoAccess />;
        const [fabrics, productTypes] = await Promise.all([listAllFabricsWithUsage(), listActiveProductTypeOptions()]);
        return (
          <>
            <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
              <div className="flex-1">
                <ProductForm
                  productId={product.id}
                  fabrics={fabrics}
                  productTypes={productTypes}
                  currentProductType={productType}
                  hasVariants={hasVariants}
                  afterUpdate={mode === "create" ? "stay" : "list"}
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
                    shippingWeightGrams: product.shippingWeightGrams === null ? "" : String(product.shippingWeightGrams),
                    productTypeCode: product.productTypeCode,
                  }}
                />
              </div>
              {canViewProfit && (
                <div className="w-full lg:w-72">
                  <ProductBatasHpp basePrice={product.basePrice} />
                </div>
              )}
            </div>
            <div className="mt-8">
              <DiscountSection
                productId={product.id}
                basePrice={product.basePrice}
                // docs/plans/product-discount.md §3.3: the chip reflects the saved discount at this render.
                status={discountStatus(product, new Date())}
                hasStoredDiscount={
                  product.discountPriceAmount !== null || product.discountEnabled || product.discountStartsAt !== null || product.discountEndsAt !== null
                }
                initialValues={{
                  priceText: product.discountPriceAmount === null ? "" : formatRupiahInput(product.discountPriceAmount),
                  enabled: product.discountEnabled,
                  startsAt: product.discountStartsAt ? utcToJakartaLocal(product.discountStartsAt) : "",
                  endsAt: product.discountEndsAt ? utcToJakartaLocal(product.discountEndsAt) : "",
                }}
              />
            </div>
          </>
        );
      }
      case "varian": {
        if (!canManageProducts) return <NoAccess />;
        const [availableColors, colorGroups] = await Promise.all([
          listFabricColors(product.fabricId, { activeOnly: true }),
          listProductColorGroups(product.id),
        ]);
        return (
          <>
            <h2 className="mb-4 text-lg font-semibold text-neutral-900">Varian</h2>
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
          </>
        );
      }
      case "foto": {
        if (!canManageProducts) return <NoAccess />;
        const colorGroups = await listProductColorGroups(product.id);
        return <ProductPhotosSection productId={product.id} thumbnailImageId={product.thumbnailImageId} colorGroups={colorGroups} images={images} />;
      }
      case "toko": {
        if (!canManageContent) return <NoAccess />;
        const sizeCharts = await listSizeCharts();
        return (
          <StorefrontSection
            productId={product.id}
            sizeMode={product.sizeMode}
            isActive={product.isActive}
            photoCount={images.length}
            photoStepHref={canManageProducts ? `${productStepHref(product.id, "foto", mode, reached)}#${PHOTO_SECTION_ID}` : null}
            hasShippingWeight={product.shippingWeightGrams !== null}
            initialValues={{
              isPublishedOnStorefront: product.isPublishedOnStorefront,
              storefrontDescriptionHtml: product.storefrontDescription ?? "",
              allsizeFitNote: product.allsizeFitNote ?? "",
              sizeChartId: product.sizeChartId,
            }}
            sizeCharts={sizeCharts}
          />
        );
      }
      case "aksesoris": {
        if (!canManageProducts) return <NoAccess />;
        const [activeAccessories, distinctSizeGroups] = await Promise.all([listActiveAccessories(), listDistinctSizeGroups()]);
        return (
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
        );
      }
    }
  }

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/products"), mode === "create" ? { label: "Tambah produk" } : { label: product.name }]} />
      <div className="flex items-start gap-4">
        {/* pb-6 matches PageHeader's own bottom padding (the admin's header-to-first-card gap),
            so the stepper card keeps that gap below whichever is taller: thumbnail or title. */}
        <div className="shrink-0 pb-6">
          <ProductThumbnail url={thumbnailUrl} className="block size-16 sm:size-20" />
        </div>
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
      <ProductStepper {...stepper} current={current} hasVariants={hasVariants}>
        {await stepContent()}
      </ProductStepper>
    </>
  );
}

function NoAccess() {
  return <p className="text-base text-neutral-600">Anda tidak punya akses untuk mengubah bagian ini.</p>;
}

async function ProductBatasHpp({ basePrice }: { basePrice: number }) {
  const costAssumption = await getCurrentCostAssumption();
  if (!costAssumption) return null;
  const batasHpp = calculateBatasHpp(basePrice, costAssumption);
  return <BatasHppCard batasHpp={batasHpp} />;
}

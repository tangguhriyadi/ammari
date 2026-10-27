import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sanitizeStorefrontDescriptionHtml } from "@ammari/content-sanitize";
import { buildProductGallery, buildProductView, getPrimaryImage, initialGalleryIndex, resolveSelectedColorId } from "@/lib/content/product-view";
import { getCachedRelatedProducts, getCachedStorefrontProduct } from "@/lib/content/product-data";
import { priceTiles, priceValidUntil, resolveStorefrontPrice, toStorefrontPrice } from "@/lib/content/storefront-price";
import { PRODUCT_PLACEHOLDER_OG_PATH } from "@/lib/content/product-placeholder";
import { getStoragePublicBaseUrl, storageImageUrl } from "@/lib/storage/public-url";
import { siteOrigin } from "@/lib/site-origin";
import { productMetaDescription } from "@/lib/seo/descriptions";
import { publicPageRobots } from "@/lib/seo/indexing";
import { htmlToPlainText } from "@/lib/seo/text";
import { buildBreadcrumbJsonLd, buildProductJsonLd, HOME_BREADCRUMB_NAME, SITE_NAME } from "@/lib/seo/json-ld";
import { JsonLd } from "@/components/json-ld";
import { isCartEnabled } from "@/lib/cart-flag";
import { getStoreContact, getWhatsappNumber } from "@/lib/store-settings";
import { Container } from "@/components/container";
import { ProductPurchasePanel } from "@/components/pdp/product-purchase-panel";
import { TrustRow } from "@/components/pdp/trust-row";
import { KeunggulanSection } from "@/components/pdp/keunggulan-section";
import { Accordions, type AccordionItemDef } from "@/components/pdp/accordions";
import { SizeChartTable } from "@/components/pdp/size-chart-table";
import { RelatedProductsSection } from "@/components/pdp/related-products-section";

// Rendered per request (docs/plans/product-discount.md §7), no longer ISR: the price is resolved
// with this request's `now`, so a product discount shows from the first request at its start time
// and is gone from the first request at its end time, with no cron or revalidation involved. The
// DB reads are cached instead (lib/content/product-data.ts, raw pricing fields, tag-revalidated by
// admin saves and payments). Like before, this route never needs database access during
// `next build`: there is no generateStaticParams, and force-dynamic never prerenders (see
// app/page.tsx's own comment on the build-time-DB bug that `/` once had).
export const dynamic = "force-dynamic";

/** Admin stores every photo at most 1600px on its longer side, never enlarged
 * (apps/admin lib/products/image-processing.ts: `fit: "inside"`, `withoutEnlargement`). */
function size1600Dimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1600 / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The product's representative photo (OG image, JSON-LD) as an absolute URL with its served
 * size, or the static 1200x630 placeholder when the product has no photo at all, so shares never
 * show a blank preview. */
function primaryOgImage(view: ReturnType<typeof buildProductView>): { url: string; width: number; height: number; alt: string; type: string } {
  const image = getPrimaryImage(view);
  if (!image) return { url: `${siteOrigin()}${PRODUCT_PLACEHOLDER_OG_PATH}`, width: 1200, height: 630, alt: view.name, type: "image/jpeg" };
  return { url: storageImageUrl(image.storageKey, 1600), ...size1600Dimensions(image.width, image.height), alt: image.altText, type: "image/webp" };
}

/** Every photo once, gallery order, for JSON-LD (Google may pick any of them). */
function productImageUrls(view: ReturnType<typeof buildProductView>): string[] {
  const urls = buildProductGallery(view).images.map((image) => storageImageUrl(image.storageKey, 1600));
  return urls.length > 0 ? urls.slice(0, 10) : [primaryOgImage(view).url];
}

function sanitizedDescriptionOf(product: { storefrontDescription: string | null }): string | null {
  return product.storefrontDescription ? sanitizeStorefrontDescriptionHtml(product.storefrontDescription) : null;
}

async function loadProduct(slug: string) {
  const product = await getCachedStorefrontProduct(slug);
  if (!product) notFound();
  return product;
}

export async function generateMetadata({ params }: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getCachedStorefrontProduct(slug);
  if (!product) return {};

  // The metadata carries no price (only the OG image needs the view).
  const view = buildProductView(product, toStorefrontPrice(resolveStorefrontPrice(product.pricing, new Date())));
  const description = productMetaDescription({
    name: product.name,
    sanitizedDescriptionHtml: sanitizedDescriptionOf(product),
    colorNames: view.colors.map((color) => color.name),
  });
  const canonical = `/products/${product.slug}`;

  return {
    title: `${product.name} | Ammari`,
    description,
    // DEPLOY_ENV convention matches app/robots.ts — only "production" is ever indexable.
    robots: publicPageRobots(process.env.DEPLOY_ENV),
    // Every `?color=` link is the same product page: one canonical URL without it (owner answer,
    // docs/plans/pdp-gallery.md §13 #7). Relative, resolved against the layout's `metadataBase`.
    alternates: { canonical },
    // Replaces the layout's openGraph as a whole, so the site-wide fields are repeated here.
    // twitter:image follows og:image (see lib/content/site-og-image.ts).
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "id_ID",
      url: canonical,
      title: product.name,
      description,
      images: [primaryOgImage(view)],
    },
  };
}

export default async function ProductPage({
  params,
  searchParams,
}: PageProps<"/products/[slug]">) {
  const { slug } = await params;
  const resolvedSearchParams = await searchParams;
  const requestedColor = typeof resolvedSearchParams.color === "string" ? resolvedSearchParams.color : null;

  const product = await loadProduct(slug);
  // One instant for the product, its JSON-LD and the related tiles.
  const now = new Date();
  const price = resolveStorefrontPrice(product.pricing, now);
  const view = buildProductView(product, toStorefrontPrice(price));
  const selectedColorId = resolveSelectedColorId(view, requestedColor);
  const [related, whatsappNumber, storeContact] = await Promise.all([
    getCachedRelatedProducts(slug, 2).then((tiles) => priceTiles(tiles, now)),
    getWhatsappNumber(),
    getStoreContact(),
  ]);

  const sanitizedDescription = sanitizedDescriptionOf(product);
  const pageUrl = `${siteOrigin()}/products/${slug}${selectedColorId ? `?color=${selectedColorId}` : ""}`;

  const accordionItems: AccordionItemDef[] = [
    {
      id: "deskripsi",
      title: "Deskripsi",
      content: sanitizedDescription ? (
        // Sanitized twice, independently (docs/plans/storefront-cms.md): once on save in
        // apps/admin, and again HERE, immediately before this is the only place its HTML ever
        // reaches `dangerouslySetInnerHTML` in apps/web.
        <div
          className="flex flex-col gap-3 [&_li]:ml-5 [&_ol]:list-decimal [&_strong]:font-medium [&_ul]:list-disc"
          dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
        />
      ) : (
        <p className="text-ink-muted">Deskripsi belum tersedia.</p>
      ),
    },
    {
      id: "perawatan",
      title: "Perawatan",
      content: <p className="whitespace-pre-line">{product.careInstructions ?? "Informasi perawatan belum tersedia."}</p>,
    },
    {
      id: "ukuran",
      title: "Ukuran",
      content:
        view.sizeMode === "sized" && view.sizeChart && view.sizeChart.length > 0 ? (
          <SizeChartTable rows={view.sizeChart} />
        ) : (
          <p>{view.allsizeFitNote ?? "Ukuran: All Size."}</p>
        ),
    },
    {
      id: "pengiriman",
      title: "Pengiriman & Pengembalian",
      // Session 8 — was hard-coded text; now reads from the Pengiriman/Pengembalian info pages
      // (docs/plans/storefront-cms.md Phase 2). Merging two independent published HTML bodies
      // into one accordion pane would force an arbitrary pick of order/truncation, so this links
      // out to each page's own full content instead of inlining either — a short, static,
      // non-origin-revealing intro (never names the shipping city, CLAUDE.md / design spec §2)
      // plus two links, needing no new field and no HTML-merging logic.
      content: (
        <div className="flex flex-col gap-3">
          {/* The store's return policy summary (store settings), first, per the owner. */}
          {storeContact.returnPolicySummary && (
            <p className="whitespace-pre-line" data-testid="return-policy-summary">
              {storeContact.returnPolicySummary}
            </p>
          )}
          <p>
            Subsidi ongkir hingga Rp20.000 per pesanan.{" "}
            <Link href="/shipping" className="underline">
              Lihat kebijakan pengiriman
            </Link>
            . Penukaran ukuran dapat diajukan sesuai syarat yang berlaku,{" "}
            <Link href="/returns-exchange" className="underline">
              lihat kebijakan pengembalian &amp; penukaran
            </Link>
            .
          </p>
        </div>
      ),
    },
  ];

  const canonicalUrl = `${siteOrigin()}/products/${product.slug}`;
  const productJsonLd = buildProductJsonLd({
    name: product.name,
    description: sanitizedDescription ? htmlToPlainText(sanitizedDescription) : "",
    url: canonicalUrl,
    images: productImageUrls(view),
    // The price charged right now (product discount included); priceValidUntil only while a
    // discount with an end time is active.
    price: price.unitPrice,
    priceValidUntil: priceValidUntil(price),
    soldOut: view.soldOut,
  });
  const breadcrumbJsonLd = buildBreadcrumbJsonLd([
    { name: HOME_BREADCRUMB_NAME, url: `${siteOrigin()}/` },
    { name: product.name, url: canonicalUrl },
  ]);

  return (
    <>
      <JsonLd data={productJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <Container className="flex flex-col gap-10 py-6 md:py-10">
        <ProductPurchasePanel
          view={view}
          initialColorId={selectedColorId}
          initialGalleryIndex={initialGalleryIndex(view, buildProductGallery(view), requestedColor)}
          cartEnabled={isCartEnabled()}
          storageBaseUrl={getStoragePublicBaseUrl()}
          whatsappNumber={whatsappNumber}
          pageUrl={pageUrl}
          afterActions={
            <div className="flex flex-col">
              <TrustRow />
              <KeunggulanSection highlights={view.highlights} />
              <Accordions items={accordionItems} />
            </div>
          }
        />
        <RelatedProductsSection products={related} />
      </Container>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRelatedStorefrontProducts, getStorefrontProductBySlug } from "@ammari/db/storefront";
import { sanitizeStorefrontDescriptionHtml } from "@ammari/content-sanitize";
import { buildProductView, getPrimaryImage, resolveSelectedColorId } from "@/lib/content/product-view";
import { PRODUCT_PLACEHOLDER_OG_PATH } from "@/lib/content/product-placeholder";
import { getStoragePublicBaseUrl, storageImageUrl } from "@/lib/storage/public-url";
import { isCartEnabled } from "@/lib/cart-flag";
import { getStoreContact, getWhatsappNumber } from "@/lib/store-settings";
import { Container } from "@/components/container";
import { ProductPurchasePanel } from "@/components/pdp/product-purchase-panel";
import { TrustRow } from "@/components/pdp/trust-row";
import { KeunggulanSection } from "@/components/pdp/keunggulan-section";
import { Accordions, type AccordionItemDef } from "@/components/pdp/accordions";
import { SizeChartTable } from "@/components/pdp/size-chart-table";
import { RelatedProductsSection } from "@/components/pdp/related-products-section";

export const revalidate = 3600;
// No generateStaticParams — every slug renders on first request and is then ISR-cached
// (dynamicParams defaults true), which also means this route never needs database access during
// `next build` itself (confirmed empirically: `next build` produces no HTML for any concrete
// slug here, unlike `/`, which — before being switched to `dynamic = "force-dynamic"` — had no
// dynamic segment and so WAS prerendered at build; see app/page.tsx's own comment).

function siteOrigin(): string {
  return (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** The product's representative photo as an absolute URL (OG image, JSON-LD), or the static
 * placeholder when the product has no photo at all, so shares never show a blank preview. */
function primaryImageUrl(view: ReturnType<typeof buildProductView>): string {
  const image = getPrimaryImage(view);
  return image ? storageImageUrl(image.storageKey, 1600) : `${siteOrigin()}${PRODUCT_PLACEHOLDER_OG_PATH}`;
}

async function loadProduct(slug: string) {
  const product = await getStorefrontProductBySlug(slug);
  if (!product) notFound();
  return product;
}

export async function generateMetadata({ params }: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getStorefrontProductBySlug(slug);
  if (!product) return {};

  const view = buildProductView(product);
  const description = product.storefrontDescription
    ? sanitizeStorefrontDescriptionHtml(product.storefrontDescription).replace(/<[^>]+>/g, " ").trim().slice(0, 160)
    : `${product.name}, Ammari syar'i gamis.`;

  return {
    title: `${product.name} | Ammari`,
    description,
    // DEPLOY_ENV convention matches app/robots.ts — only "production" is ever indexable.
    robots: { index: process.env.DEPLOY_ENV === "production", follow: process.env.DEPLOY_ENV === "production" },
    openGraph: {
      title: product.name,
      description,
      images: [{ url: primaryImageUrl(view) }],
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
  const view = buildProductView(product);
  const selectedColorId = resolveSelectedColorId(view, requestedColor);
  const [related, whatsappNumber, storeContact] = await Promise.all([
    getRelatedStorefrontProducts({ excludeSlug: slug, limit: 2 }),
    getWhatsappNumber(),
    getStoreContact(),
  ]);

  const sanitizedDescription = product.storefrontDescription ? sanitizeStorefrontDescriptionHtml(product.storefrontDescription) : null;
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
        <p>
          Ongkos kirim dihitung otomatis saat checkout berdasarkan alamat tujuan.{" "}
          <Link href="/shipping" className="underline">
            Lihat kebijakan pengiriman
          </Link>
          . Penukaran ukuran dapat diajukan sesuai syarat yang berlaku,{" "}
          <Link href="/returns-exchange" className="underline">
            lihat kebijakan pengembalian &amp; penukaran
          </Link>
          .
        </p>
      ),
    },
  ];

  const plainTextDescription = sanitizedDescription ? sanitizedDescription.replace(/<[^>]+>/g, " ").trim() : undefined;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: plainTextDescription,
    image: primaryImageUrl(view),
    offers: {
      "@type": "Offer",
      priceCurrency: "IDR",
      price: product.basePrice,
      availability: product.variants.some((variant) => variant.available)
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
      url: pageUrl,
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Container className="flex flex-col gap-10 py-6 md:py-10">
        <ProductPurchasePanel
          view={view}
          initialColorId={selectedColorId}
          cartEnabled={isCartEnabled()}
          storageBaseUrl={getStoragePublicBaseUrl()}
          whatsappNumber={whatsappNumber}
          pageUrl={pageUrl}
          afterActions={
            <div className="flex flex-col">
              <TrustRow returnPolicySummary={storeContact.returnPolicySummary} />
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

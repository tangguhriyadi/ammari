import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRelatedStorefrontProducts, getStorefrontProductBySlug } from "@ammari/db/storefront";
import { sanitizeStorefrontDescriptionHtml } from "@ammari/content-sanitize";
import { buildProductView, resolveSelectedColorId } from "@/lib/content/product-view";
import { getStoragePublicBaseUrl, storageImageUrl } from "@/lib/storage/public-url";
import { isCartEnabled } from "@/lib/cart-flag";
import { getWhatsappNumber } from "@/lib/store-settings";
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
  const firstImage = view.generalImages[0] ?? Object.values(view.imagesByColor)[0]?.[0];
  const description = product.storefrontDescription
    ? sanitizeStorefrontDescriptionHtml(product.storefrontDescription).replace(/<[^>]+>/g, " ").trim().slice(0, 160)
    : `${product.name} — Ammari, syar'i gamis.`;

  return {
    title: `${product.name} — Ammari`,
    description,
    // DEPLOY_ENV convention matches app/robots.ts — only "production" is ever indexable.
    robots: { index: process.env.DEPLOY_ENV === "production", follow: process.env.DEPLOY_ENV === "production" },
    openGraph: {
      title: product.name,
      description,
      images: firstImage ? [{ url: storageImageUrl(firstImage.storageKey, 1600) }] : [],
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
  const related = await getRelatedStorefrontProducts({ excludeSlug: slug, limit: 2 });

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
      content: (
        <p>
          Pesanan diproses dan dikirim menggunakan jasa kurir pilihan. Ongkos kirim dihitung otomatis saat
          checkout berdasarkan alamat tujuan. Penukaran ukuran dapat diajukan sesuai syarat &amp; ketentuan
          yang berlaku.
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
    image: view.generalImages[0] ? storageImageUrl(view.generalImages[0].storageKey, 1600) : undefined,
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
          whatsappNumber={getWhatsappNumber()}
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

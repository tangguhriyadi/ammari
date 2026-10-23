import { existsSync } from "node:fs";
import type { FullConfig } from "@playwright/test";

// Fixed, distinctive text the spec asserts on directly — if the preview page ever showed
// PUBLISHED content instead of DRAFT content, this string would simply never appear (nothing
// publishes it in this setup), which is exactly the bug this test exists to catch.
export const E2E_PREVIEW_DRAFT_HEADLINE = "E2E Draft Headline — belum terbit";

function assertSafeTarget(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed e2e preview fixtures: NODE_ENV is production.");
  }
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is not set");
  const url = new URL(rawUrl);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const dbName = url.pathname.replace(/^\//, "");
  // Exact name, not just "is local" — e2e fixtures must land in their own database
  // (ammari_e2e), never the owner's real local `ammari` dev database (CLAUDE.md's "Local
  // environment safety" rule) — same guard apps/admin/e2e/global-setup.ts applies.
  if (!isLocalHost || dbName !== "ammari_e2e") {
    throw new Error(
      `Refusing to seed e2e preview fixtures: derived target is "${url.hostname}${url.pathname}". ` +
        `e2e only ever runs against host localhost/127.0.0.1, database "ammari_e2e". Check DATABASE_URL.`,
    );
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Loaded here, and @ammari/db imported dynamically below — see apps/admin/e2e/global-setup.ts's
  // own doc comment on why a static import would evaluate (and throw) before this line ran.
  if (existsSync(".env")) process.loadEnvFile(".env");

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed e2e preview fixtures: NODE_ENV is production.");
  }
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is not set");

  const e2eUrl = new URL(baseUrl);
  e2eUrl.pathname = "/ammari_e2e";
  const isLocalHost = e2eUrl.hostname === "localhost" || e2eUrl.hostname === "127.0.0.1";
  if (!isLocalHost) {
    throw new Error(`Refusing to seed e2e preview fixtures against non-local host "${e2eUrl.hostname}".`);
  }
  process.env.DATABASE_URL = e2eUrl.toString();

  const { ensureE2eDatabase } = await import("@ammari/db/test-e2e-db");
  await ensureE2eDatabase(baseUrl);
  assertSafeTarget();

  const { eq } = await import("drizzle-orm");
  const { db } = await import("@ammari/db");
  const { storefrontHomepageSections } = await import("@ammari/db/schema");

  // Draft-only — published columns stay null/untouched, so a preview that accidentally read
  // getPublishedHomepageContent() instead of getDraftHomepageContent() would show nothing for
  // this section, not this headline.
  await db
    .update(storefrontHomepageSections)
    .set({
      draftIsVisible: true,
      draftContent: {
        eyebrow: "E2E",
        headline: E2E_PREVIEW_DRAFT_HEADLINE,
        ctaLabel: "Lihat",
        ctaTarget: { type: "anchor" },
        image: null,
      },
      draftUpdatedAt: new Date(),
    })
    .where(eq(storefrontHomepageSections.key, "hero"));

  // The other 3 sections are hidden in the draft for this test — keeps the preview page's
  // output focused on exactly the hero headline the spec asserts on, not incidental default
  // content from the other sections.
  for (const key of ["product_grid", "feature_block", "why_ammari"] as const) {
    await db.update(storefrontHomepageSections).set({ draftIsVisible: false }).where(eq(storefrontHomepageSections.key, key));
  }

  // PUBLISHED storefront fixtures (products, homepage sections) for home.spec.ts and
  // product-page.spec.ts — a separate module, see its own doc comment.
  const { seedStorefrontFixtures } = await import("./storefront-fixtures");
  await seedStorefrontFixtures();
  // Product discount fixtures (product-discount.spec.ts), kept out of every other spec's way.
  const { seedDiscountFixtures } = await import("./discount-fixtures");
  await seedDiscountFixtures();

  // The PDP's data cache (lib/content/product-data.ts, unstable_cache) lives on disk under .next and
  // outlives the dev server, while the seed above gives the variants new SKUs every run: a PDP entry
  // from the previous run would offer SKUs that no longer exist ("Produk ini tidak tersedia lagi").
  // The dev server is already up (Playwright starts it before this), so expire every product's tag
  // through /api/revalidate, like an admin save does, 8 per request (the route's 10-tag cap).
  const { products } = await import("@ammari/db/schema");
  const { E2E_REVALIDATE_SECRET } = await import("./helpers/revalidate-secret");
  // The dev server's origin, from playwright.config.ts's own webServer.url (one source of truth).
  const webServers = config.webServer ? [config.webServer].flat() : [];
  const healthUrl = webServers[0]?.url;
  if (!healthUrl) throw new Error("e2e cache reset: playwright.config.ts has no webServer.url");
  const serverOrigin = new URL(healthUrl).origin;
  const slugs = (await db.select({ slug: products.slug }).from(products)).map((row) => row.slug);
  for (let index = 0; index < slugs.length; index += 8) {
    const tags = [...slugs.slice(index, index + 8).map((slug) => `storefront:product:${slug}`), "storefront:products", "storefront:homepage"];
    const response = await fetch(new URL("/api/revalidate", serverOrigin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": E2E_REVALIDATE_SECRET },
      body: JSON.stringify({ tags }),
    });
    if (!response.ok) throw new Error(`e2e cache reset: /api/revalidate answered ${response.status}`);
  }
}

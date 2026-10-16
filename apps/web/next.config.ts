import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@ammari/db", "@ammari/auth", "@ammari/ui"],
  // `next dev`'s own floating "N" build-activity badge has nothing to do with this storefront's
  // UI — it's a dev-only overlay (never shown by `next start`), but it still shows up baked into
  // any full-page screenshot taken against the dev server (e2e/visual-screenshots.spec.ts),
  // wrongly reading as part of the page. Off entirely rather than just repositioned.
  devIndicators: false,
  // Next 16 takes an exclusive, cross-process lock at `<distDir>/lock` and refuses to start a
  // second `next dev` for the same project directory even on a different port — a distinct
  // distDir per instance (gated on E2E_TEST_LOGIN, set only by playwright.config.ts's
  // webServer.env, see `dev:e2e`) keeps the owner's own `pnpm dev` (:3000) and the e2e dev
  // server (:3100) fully independent. Same fix apps/admin/next.config.ts already applies for
  // its own :3001/:3101 pair — see that file's own doc comment for how this was discovered.
  distDir: process.env.E2E_TEST_LOGIN === "true" ? ".next-e2e" : ".next",
  // `images.remotePatterns` CANNOT be driven by `process.env.STORAGE_PUBLIC_BASE_URL` here, even
  // though that's the normal next/image pattern: per apps/web/Dockerfile, this image is built
  // ONCE in CI with placeholder env (see its "ENV NODE_ENV=production DATABASE_URL=... " block's
  // own comment) and deployed environment-neutral — the real STORAGE_PUBLIC_BASE_URL is only
  // ever injected at container RUNTIME (deploy/env/web.env). Next's standalone server reads its
  // resolved image config from `required-server-files.json`, generated once at `next build` time
  // — an env-derived `remotePatterns` would freeze in whatever (empty) value the CI build saw,
  // and no runtime env change could ever fix it without a rebuild (same class of bug the cart
  // feature flag almost had — see lib/cart-flag.ts's own doc comment).
  //
  // Since apps/admin's own upload pipeline already produces exactly 3 fixed WebP sizes per image
  // (400/800/1600 — image-processing.ts) before anything reaches storage, next/image's own
  // server-side resize/reformat step would just be redundant work on an already-optimized file.
  // `unoptimized: true` skips that step (and, not incidentally, the allowlist check that would
  // otherwise need the build-time-unknown host) while keeping next/image's other benefits — lazy
  // loading, `priority` for LCP, zero layout shift via `fill` + an aspect-ratio container.
  // lib/storage/public-url.ts's `storageImageUrl()` picks the right one of the 3 pre-generated
  // sizes per call site instead.
  images: {
    unoptimized: true,
  },
  // Belt-and-suspenders on top of the page's own `metadata.robots` (a <meta> tag, not an HTTP
  // header) and `Cache-Control` (the page itself sets `dynamic = "force-dynamic"`, which stops
  // NEXT's own route cache but says nothing about a browser/CDN cache) — see
  // docs/plans/storefront-cms.md session 6. Static config, not middleware: the path is fixed, so
  // this never needs per-request logic.
  async headers() {
    return [
      {
        source: "/preview/home",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;

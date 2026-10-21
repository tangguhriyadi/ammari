import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@ammari/db", "@ammari/auth", "@ammari/commerce", "@ammari/ui"],
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
  //
  // DEPLOY_REGRESSION_TEST (set only by test/homepage-deploy-regression.test.ts): that test runs
  // a real `next build` + `next start`, outside Vitest's module graph, to reproduce the
  // build-time-DB-unavailable deploy scenario — it needs its own distDir so it never reads or
  // clobbers the developer's own `.next` (possibly mid-`pnpm dev`) or the Playwright e2e build.
  // CRON_AUTH_STANDALONE_TEST (set only by test/cron-auth-standalone.test.ts): same reason, for
  // that test's own `next build` + standalone `server.js`.
  distDir:
    process.env.E2E_TEST_LOGIN === "true"
      ? ".next-e2e"
      : process.env.DEPLOY_REGRESSION_TEST === "true"
        ? ".next-deploy-regression-test"
        : process.env.CRON_AUTH_STANDALONE_TEST === "true"
          ? ".next-cron-auth-test"
          : ".next",
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
      // The "Masuk ke akun" confirm page carries a one-time login token in its URL
      // (docs/plans/cart-checkout.md §9.3, session 14): never indexed or cached, and the URL never
      // sent to another site. `same-origin`, not `no-referrer`: under `no-referrer` browsers send
      // `Origin: null` on the page's own form POST, which the login's CSRF check would then have to
      // guess (owner decision 2026-10-21).
      {
        source: "/login/link",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "same-origin" },
          // Never framed: a framed "Masuk" button would let another site log a visitor into the
          // attacker's own account (security review, session 14).
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      // The account page carries the contact offer's "Simpan" (session 14): not framed either.
      {
        source: "/account",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      // "Pesanan saya" (docs/plans/cart-checkout.md §9, session 15). The email link
      // `/orders/<no>?t=<token>` is answered by the token route (rewrites below), which renders
      // nothing and sends the token URL nowhere: `no-referrer`. The token-free pages send
      // `same-origin` instead (owner decision 2026-10-21): no Referer ever leaves the site, while
      // the page's own server actions ("Pesan lagi", the payment buttons) keep a real Origin, which
      // Next's CSRF check needs (`no-referrer` makes browsers send `Origin: null`). Never framed
      // (the contact offer, "Pesan lagi"), never indexed.
      // The query-dependent split applies to the order page only (where `?t=` is rewritten);
      // `/orders` gets its headers whatever the query (security review, session 15: a `missing`
      // condition there let `/orders?t=x` render the list unprotected).
      {
        source: "/orders/:orderNo",
        has: [{ type: "query", key: "t" }],
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      ...[
        { source: "/orders", missing: undefined },
        { source: "/orders/:orderNo", missing: [{ type: "query" as const, key: "t" }] },
      ].map(({ source, missing }) => ({
        source,
        ...(missing ? { missing } : {}),
        headers: [
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      })),
    ];
  },
  // The "Lihat pesanan" token is swapped for a cookie before any page renders (§9.2): the request
  // with `?t=` goes to the token route, which redirects to the token-free URL. No proxy file
  // (apps/web has none by design); a beforeFiles rewrite, so it wins over the order page itself.
  async rewrites() {
    return {
      beforeFiles: [{ source: "/orders/:orderNo", has: [{ type: "query", key: "t" }], destination: "/api/orders/:orderNo/view" }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;

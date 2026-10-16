import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@ammari/db", "@ammari/auth", "@ammari/ui"],
  // Next 16 takes an exclusive, cross-process lock at `<distDir>/lock` and refuses to start a
  // second `next dev` for the same project directory even on a different port — a distinct
  // distDir per instance (gated on E2E_TEST_LOGIN, set only by playwright.config.ts's
  // webServer.env, see `dev:e2e`) keeps the owner's own `pnpm dev` (:3000) and the e2e dev
  // server (:3100) fully independent. Same fix apps/admin/next.config.ts already applies for
  // its own :3001/:3101 pair — see that file's own doc comment for how this was discovered.
  distDir: process.env.E2E_TEST_LOGIN === "true" ? ".next-e2e" : ".next",
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

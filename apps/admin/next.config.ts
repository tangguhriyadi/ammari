import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@ammari/db", "@ammari/auth", "@ammari/storage", "@ammari/ui"],
  // Next 16 takes an exclusive, cross-process lock at `<distDir>/lock` and REFUSES to start a
  // second `next dev` for the same project directory, even on a different port — discovered the
  // hard way debugging a "/packing shows nothing" report: `playwright.config.ts`'s own `next
  // dev` (a SEPARATE port, 3101) would otherwise collide with the owner's own `pnpm dev` on
  // :3001 purely because both share the default `.next` distDir, and Playwright's
  // `reuseExistingServer` logic could end up silently talking to whichever server (the owner's
  // real one, or a stale leftover from an earlier e2e run) already held that lock. A distinct
  // distDir per instance — gated on `E2E_TEST_LOGIN` (set only by playwright.config.ts's
  // webServer.env, see `dev:e2e`) — makes the two dev servers (and their locks) fully
  // independent, so they can run side by side with zero risk of one affecting the other.
  distDir: process.env.E2E_TEST_LOGIN === "true" ? ".next-e2e" : ".next",
  // Permanent redirects from the old Indonesian route paths to the English ones (see CLAUDE.md's
  // URL convention) — keeps old bookmarks/links working. Specific sub-paths come before their
  // parent's catch-all so e.g. "/produk/baru" lands on "/products/new", not "/products/baru".
  async redirects() {
    return [
      { source: "/pesanan", destination: "/orders", permanent: true },
      { source: "/impor", destination: "/import", permanent: true },
      { source: "/stok", destination: "/stock", permanent: true },
      { source: "/produksi", destination: "/production", permanent: true },
      { source: "/produk/baru", destination: "/products/new", permanent: true },
      { source: "/produk/:id", destination: "/products/:id", permanent: true },
      { source: "/produk", destination: "/products", permanent: true },
      { source: "/bahan/baru", destination: "/fabrics/new", permanent: true },
      { source: "/bahan/:id", destination: "/fabrics/:id", permanent: true },
      { source: "/bahan", destination: "/fabrics", permanent: true },
      { source: "/iklan-biaya", destination: "/ads-expenses", permanent: true },
      { source: "/pelanggan-voucher", destination: "/customers", permanent: true },
      { source: "/pengaturan", destination: "/settings", permanent: true },
      { source: "/peran-staf", destination: "/roles-staff", permanent: true },
      { source: "/log-aktivitas", destination: "/activity-log", permanent: true },
    ];
  },
  experimental: {
    // Required for next/navigation's forbidden() — see apps/admin/src/app/forbidden.tsx and
    // lib/auth/require-permission.ts.
    authInterrupts: true,
    serverActions: {
      // Product image upload sends ONE file per action call (see uploadProductImageAction) —
      // the server still independently enforces 10 MB per file; 12mb leaves ~2MB of headroom
      // for multipart/form-data's own boundary/header/field overhead on top of the file bytes.
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@ammari/db", "@ammari/auth", "@ammari/storage", "@ammari/ui"],
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

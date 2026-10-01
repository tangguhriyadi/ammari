import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@ammari/db", "@ammari/auth"],
  experimental: {
    // Required for next/navigation's forbidden() — see apps/admin/src/app/forbidden.tsx and
    // lib/auth/require-permission.ts.
    authInterrupts: true,
  },
};

export default nextConfig;

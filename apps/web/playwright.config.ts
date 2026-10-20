import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

if (existsSync(".env")) process.loadEnvFile(".env");

// Same derivation as apps/admin/playwright.config.ts's own e2eDatabaseUrl() — kept in sync with
// that copy rather than imported (Playwright only transpiles this config file itself, not its
// workspace dependencies — a static import of an ESM-only sibling package fails under Node's
// plain `require()` when Playwright loads this file).
function e2eDatabaseUrl(): string {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is not set");
  const url = new URL(baseUrl);
  url.pathname = "/ammari_e2e";
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalHost) {
    throw new Error(
      `Refusing to point the e2e dev server at "${url.hostname}${url.pathname}" — e2e only ever runs against ` +
        `host localhost/127.0.0.1, database "ammari_e2e". Check DATABASE_URL.`,
    );
  }
  return url.toString();
}

// Fixed only for the e2e run (never a real deployed value) — global-setup.ts and the spec files
// both need to agree on this exact string: global-setup seeds nothing secret-dependent, but the
// spec mints tokens through the real /api/test/preview-token backdoor, which signs with whatever
// PREVIEW_SECRET the running dev server actually has.
export const E2E_PREVIEW_SECRET = "e2e-test-preview-secret-do-not-use-in-prod";

// Fixed for every e2e run — product-page.spec.ts asserts the "Tanya via WhatsApp" link's href
// against this exact number (lib/store-settings.ts).
export const E2E_WHATSAPP_NUMBER = "6281234567890";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // "dev:e2e" (not "dev"): binds to 127.0.0.1 only, so the e2e-token backdoor's localhost
    // check (lib/preview/e2e-gate.ts) is backed by an actual network-layer guarantee, not just a
    // client-supplied Host header anyone reaching the port could spoof — same reasoning
    // apps/admin/playwright.config.ts gives for its own dev:e2e.
    command: "pnpm dev:e2e",
    // `/api/health`, NOT `/` — Playwright polls this URL to decide the dev server is "ready,"
    // which happens BEFORE global-setup.ts seeds ammari_e2e's homepage/product fixtures. Polling
    // `/` would make that very first (premature, pre-seed) request to the homepage the one that
    // fills its `unstable_cache` entry (lib/content/homepage-data.ts) — caching "nothing
    // published yet" for this dev server's entire run (the cache's 1h `revalidate`, with nothing
    // in an e2e run ever calling `revalidateTag` to bust it), so every real test's `page.goto("/")`
    // would see that same stale-empty result regardless of what global-setup wrote afterward.
    // `/api/health` only pings the DB — it reads no application-level cache, so it can't poison
    // one.
    url: "http://localhost:3100/api/health",
    reuseExistingServer: false,
    env: {
      E2E_TEST_LOGIN: "true",
      DATABASE_URL: e2eDatabaseUrl(),
      PREVIEW_SECRET: E2E_PREVIEW_SECRET,
      // .env's BETTER_AUTH_URL is the real dev port (3000) — Better Auth's own origin check
      // (createCustomerAuth's `trustedOrigins: [baseURL]`) rejects every request that doesn't
      // match it exactly, and this server actually runs on 3100. See
      // apps/admin/playwright.config.ts's own identical fix for the same issue, surfaced the
      // same way: login-otp.spec.ts is the first web spec to drive the real `/api/auth/*`
      // endpoint instead of a backdoor that bypasses it.
      BETTER_AUTH_URL: "http://localhost:3100",
      // E2E_OTP_EXPIRES_IN_SECONDS: only honored behind E2E_TEST_LOGIN (lib/auth/customer.ts) —
      // lets login-otp.spec.ts's "expired code rejected" test wait a handful of real seconds
      // instead of 5 real minutes.
      E2E_OTP_EXPIRES_IN_SECONDS: "8",
      // Images resolve to real, fetchable files during the e2e run: committed fixture WebPs
      // under apps/web/e2e/fixtures/*, served by this very dev server through the e2e-only
      // app/api/test/fixtures/[...path] route, so
      // `${STORAGE_PUBLIC_BASE_URL}/api/test/fixtures/<name>/<size>.webp` is a real URL — never
      // a mock/placeholder scheme (see storefront-fixtures.ts's own doc comment).
      STORAGE_PUBLIC_BASE_URL: "http://localhost:3100",
      // Off by default, the real shipped default (lib/cart-flag.ts): `pnpm test:e2e`.
      // `pnpm test:e2e:cart` (E2E_CART_ENABLED=true) runs the same suite with the cart on; specs
      // pick their expectations from e2e/helpers/cart-flag.ts. Run both before shipping cart work.
      STOREFRONT_CART_ENABLED: process.env.E2E_CART_ENABLED === "true" ? "true" : "false",
      STORE_WHATSAPP_NUMBER: E2E_WHATSAPP_NUMBER,
    },
    timeout: 120_000,
  },
});

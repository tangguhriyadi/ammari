import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

if (existsSync(".env")) process.loadEnvFile(".env");

// The `next dev` server this config spawns below must never write into the owner's real local
// `ammari` database (see CLAUDE.md's "Local environment safety" rule) — e2e/global-setup.ts
// separately creates/migrates/seeds this same `ammari_e2e` database before any test runs.
//
// Deliberately NOT imported from @ammari/db/test-e2e-db (which has the "real",
// network-touching version of this same derivation, deriveE2eDatabaseUrl): Playwright only
// transpiles this config file itself when loading it, not its workspace dependencies, so a
// static import of an ESM-only (`import.meta.url`) sibling package fails under Node's plain
// `require()`. This copy is pure URL parsing with no DB/module dependency — keep the two in
// sync if the database name or guard logic ever changes.
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

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Not parallel: every test signs in through the same single `pnpm dev` process and its one
  // in-memory CapturingEmailSender (e2e-login-gate's whole design assumes one OTP in flight per
  // email at a time) — concurrent logins as the same e2e fixture email race each other's OTP.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    // A dedicated port (3101), distinct from the owner's own `pnpm dev` on :3001 — e2e must
    // never be able to collide with or reuse a developer's own running dev server (that
    // confuses which database/env a request actually hit — this exact scenario cost real
    // debugging time once already: a stale e2e-flavored server left running on :3001 looked,
    // from the browser, indistinguishable from the owner's own server).
    baseURL: "http://localhost:3101",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // WebKit only runs the print spec (not the whole suite) — this project exists specifically
    // to catch print-timing/rendering bugs (window.print() racing a not-yet-painted DOM) that
    // are real cross-browser risks but that nothing else in this suite needs a second engine
    // for; `page.pdf()` itself is Chromium-only, so the WebKit runs skip that half of each test.
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: /packing-print\.spec\.ts/ },
  ],
  webServer: {
    // "dev:e2e" (not "dev"): binds to 127.0.0.1 only, so the sign-in backdoor's localhost check
    // (e2e-login-gate.ts) is backed by an actual network-layer guarantee — nothing outside this
    // machine can even open a TCP connection — rather than trusting the client-supplied Host/
    // x-forwarded-for headers on their own, which anyone reaching the port could otherwise spoof.
    command: "pnpm dev:e2e",
    url: "http://localhost:3101",
    // Always false, not just outside CI — reusing ANY already-running server here (even one
    // Playwright itself spawned earlier and failed to tear down) risks silently testing against
    // stale compiled code or a stale env. With a dedicated port, "already in use" now fails
    // loudly instead of quietly reusing something unknown — the correct failure mode for a
    // leftover process, not a thing to paper over by reusing it.
    reuseExistingServer: false,
    // STORAGE_DRIVER=memory swaps in the in-memory StorageClient (src/lib/storage.ts) — same
    // idea as E2E_TEST_LOGIN above, so e2e needs no real bucket. Fails closed in production,
    // same as the login backdoor. DATABASE_URL is overridden to the isolated ammari_e2e
    // database — see e2eDatabaseUrl() above. MAIN_SITE_URL is a harmless placeholder — e2e never
    // exercises the real apps/web, only that lib/main-site-url.ts's validation passes and the
    // packing claim URL builds from SOME configured value (see lib/packing/token.ts).
    env: { E2E_TEST_LOGIN: "true", STORAGE_DRIVER: "memory", DATABASE_URL: e2eDatabaseUrl(), MAIN_SITE_URL: "http://localhost:3000" },
    timeout: 120_000,
  },
});

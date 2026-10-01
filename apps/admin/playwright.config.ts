import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

if (existsSync(".env")) process.loadEnvFile(".env");

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
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // "dev:e2e" (not "dev"): binds to 127.0.0.1 only, so the sign-in backdoor's localhost check
    // (e2e-login-gate.ts) is backed by an actual network-layer guarantee — nothing outside this
    // machine can even open a TCP connection — rather than trusting the client-supplied Host/
    // x-forwarded-for headers on their own, which anyone reaching the port could otherwise spoof.
    command: "pnpm dev:e2e",
    url: "http://localhost:3001",
    reuseExistingServer: !process.env.CI,
    env: { E2E_TEST_LOGIN: "true" },
    timeout: 120_000,
  },
});

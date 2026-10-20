// Which way the e2e dev server runs the cart flag: `pnpm test:e2e` keeps the shipped default
// (off); `pnpm test:e2e:cart` sets E2E_CART_ENABLED=true, which playwright.config.ts passes to
// the server as STOREFRONT_CART_ENABLED. Spec workers inherit the runner's environment, so specs
// read the same variable to pick their expectations (or skip a test that only holds one way).
export const CART_E2E = process.env.E2E_CART_ENABLED === "true";

// /api/revalidate's secret for the e2e run only (playwright.config.ts passes it to the dev server):
// product-discount.spec.ts refreshes a product's cache the way an admin discount save does
// (apps/admin lib/revalidate.ts). Never a deployed value. No imports, so the config can load it.
export const E2E_REVALIDATE_SECRET = ["e2e", "revalidate", "secret", "0".repeat(24)].join("-");

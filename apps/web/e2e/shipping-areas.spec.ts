import { expect, test } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";

// docs/plans/cart-checkout.md §4.5.1, session 8: the checkout area search route with the fake
// provider (playwright.config.ts sets SHIPPING_RATE_PROVIDER=fake). The combobox that calls it
// arrives with the checkout UI (session 10, with its own 390/1280 e2e); this spec only pins the
// route's contract in both flag states. Requests go through the page so the browser sends its own
// Sec-Fetch-Site, as the combobox will.

async function searchFromPage(page: import("@playwright/test").Page, q: string) {
  await page.goto("/");
  return page.evaluate(async (query) => {
    const response = await fetch(`/api/shipping/areas?q=${encodeURIComponent(query)}`);
    return { status: response.status, cacheControl: response.headers.get("cache-control"), body: response.status === 404 ? null : await response.json() };
  }, q);
}

test.describe("area search, flag off", () => {
  test.skip(CART_E2E, "flag-off behaviour");

  test("is not found", async ({ page }) => {
    const result = await searchFromPage(page, "kecamatan e2e");
    expect(result.status).toBe(404);
  });
});

test.describe("area search, flag on", () => {
  test.skip(!CART_E2E, "needs STOREFRONT_CART_ENABLED (pnpm test:e2e:cart)");

  test("returns fictional areas with our ids and labels, never cached", async ({ page }) => {
    const result = await searchFromPage(page, "kecamatan e2e jauh");
    expect(result.status).toBe(200);
    expect(result.cacheControl).toBe("private, no-store");
    expect(result.body).toEqual({
      areas: [{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), label: "Kecamatan E2E Jauh, Kabupaten E2E, Provinsi E2E Timur 99111", hasPostalCode: true }],
    });
  });

  test("too short and outage states answer in Indonesian", async ({ page }) => {
    expect(await searchFromPage(page, "ab")).toMatchObject({ status: 400, body: { error: "Ketik minimal 3 huruf." } });
    expect(await searchFromPage(page, "pencarian gagal")).toMatchObject({
      status: 503,
      body: { error: "Pencarian alamat belum bisa dipakai. Coba lagi sebentar lagi." },
    });
  });

  test("a cross-site request is refused", async ({ request }) => {
    const response = await request.get("/api/shipping/areas?q=kecamatan%20e2e", { headers: { "sec-fetch-site": "cross-site" } });
    expect(response.status()).toBe(403);
  });
});

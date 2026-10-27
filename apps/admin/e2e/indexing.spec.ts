import { expect, test } from "@playwright/test";

// The admin is never indexed, dev or prod (docs/plans/seo.md): robots.txt disallows everything
// and is readable with no session, every response carries X-Robots-Tag noindex (the /login
// redirect included), and the login page has the robots meta.

test("robots.txt disallows everything and needs no session", async ({ request }) => {
  const response = await request.get("/robots.txt", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain("User-Agent: *");
  expect(body).toContain("Disallow: /");
  expect(body).not.toContain("Allow: /\n");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
});

test("the unauthenticated redirect and the login page carry noindex", async ({ request, page }) => {
  const redirect = await request.get("/orders", { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(redirect.headers()["x-robots-tag"]).toContain("noindex");

  const response = await page.goto("/login");
  expect(response?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
});

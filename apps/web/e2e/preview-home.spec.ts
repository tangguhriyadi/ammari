import { expect, test } from "@playwright/test";
import { E2E_PREVIEW_DRAFT_HEADLINE } from "./global-setup";

async function mintToken(request: import("@playwright/test").APIRequestContext, ttlSeconds?: number): Promise<string> {
  const response = await request.post("/api/test/preview-token", {
    data: ttlSeconds === undefined ? {} : { ttlSeconds },
  });
  expect(response.ok()).toBe(true);
  const { token } = await response.json();
  return token as string;
}

test("a valid token renders the draft homepage content, with the draft banner and nothing published", async ({ page, request }) => {
  const token = await mintToken(request);
  await page.goto(`/preview/home?token=${encodeURIComponent(token)}`);

  await expect(page.getByTestId("preview-draft-banner")).toBeVisible();
  await expect(page.getByText(E2E_PREVIEW_DRAFT_HEADLINE)).toBeVisible();
});

test("a missing token is rejected with 404, never rendering draft content", async ({ page }) => {
  const response = await page.goto("/preview/home");
  expect(response?.status()).toBe(404);
  await expect(page.getByText(E2E_PREVIEW_DRAFT_HEADLINE)).toHaveCount(0);
});

test("an expired token is rejected with 404", async ({ page, request }) => {
  const token = await mintToken(request, -60);
  const response = await page.goto(`/preview/home?token=${encodeURIComponent(token)}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText(E2E_PREVIEW_DRAFT_HEADLINE)).toHaveCount(0);
});

test("a tampered token is rejected with 404", async ({ page, request }) => {
  const token = await mintToken(request);
  const [expiresAt, mac] = token.split(".");
  const flippedLastChar = mac!.slice(0, -1) + (mac!.at(-1) === "0" ? "1" : "0");
  const tampered = `${expiresAt}.${flippedLastChar}`;

  const response = await page.goto(`/preview/home?token=${encodeURIComponent(tampered)}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText(E2E_PREVIEW_DRAFT_HEADLINE)).toHaveCount(0);
});

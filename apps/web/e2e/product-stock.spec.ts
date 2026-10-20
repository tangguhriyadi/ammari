import { expect, test, type Page } from "@playwright/test";
import {
  E2E_PARTIAL_STOCK_PRODUCT_SLUG,
  E2E_PRODUCT_SLUG,
  E2E_RETURN_POLICY_SUMMARY,
  E2E_SOLD_OUT_PRODUCT_NAME,
  E2E_SOLD_OUT_PRODUCT_SLUG,
} from "./storefront-fixtures";
import { CART_E2E } from "./helpers/cart-flag";

// With the cart on, WhatsApp is the outlined secondary action and stays even when sold out; with
// it off (the shipped default) it is the main CTA, which SOLD OUT replaces.
const WHATSAPP_WHEN_SOLD_OUT = CART_E2E ? 1 : 0;

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

async function openPdp(page: Page, slug: string, viewport: { width: number; height: number }, color?: string) {
  await page.setViewportSize(viewport);
  await page.goto(`/products/${slug}`);
  if (color) await page.getByRole("button", { name: color }).click();
}

test.describe("PDP stock states", () => {
  for (const viewport of VIEWPORTS) {
    test(`mixed stock: only M selectable, S and L habis, XS and XL hidden, WhatsApp CTA stays (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_PARTIAL_STOCK_PRODUCT_SLUG, viewport);

      await expect(page.getByRole("button", { name: "Ukuran S habis", exact: true })).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("button", { name: "Ukuran L habis", exact: true })).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("button", { name: /^(XS|XL)\b/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Ukuran S habis", exact: true })).toHaveCSS("text-decoration-line", "line-through");

      // Clicking a habis size does not select it.
      await page.getByRole("button", { name: "Ukuran S habis", exact: true }).click({ force: true });
      await expect(page.getByText("Ukuran: S")).toHaveCount(0);
      await page.getByRole("button", { name: "M", exact: true }).click();
      await expect(page.getByText("Ukuran: M")).toBeVisible();

      await expect(page.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "SOLD OUT" })).toHaveCount(0);
    });

    test(`colour switch re-evaluates: Mocca has only an empty M, so the CTA becomes SOLD OUT; Sage restores it (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_PARTIAL_STOCK_PRODUCT_SLUG, viewport);
      await page.getByRole("button", { name: "Mocca E2E" }).click();

      await expect(page.getByRole("button", { name: "Ukuran M habis", exact: true })).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("button", { name: "Ukuran S habis", exact: true })).toHaveCount(0);
      const soldOut = page.getByRole("button", { name: "SOLD OUT" });
      await expect(soldOut).toBeDisabled();
      await expect(soldOut).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("link", { name: /Tanya via WhatsApp/ })).toHaveCount(WHATSAPP_WHEN_SOLD_OUT);

      await page.getByRole("button", { name: "Sage E2E" }).click();
      await expect(page.getByRole("button", { name: "SOLD OUT" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeVisible();
    });

    test(`a product with no stock at all shows a disabled SOLD OUT instead of the WhatsApp CTA (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_SOLD_OUT_PRODUCT_SLUG, viewport);
      const soldOut = page.getByRole("button", { name: "SOLD OUT" });
      await expect(soldOut).toBeVisible();
      await expect(soldOut).toBeDisabled();
      await expect(page.getByRole("link", { name: /Tanya via WhatsApp/ })).toHaveCount(WHATSAPP_WHEN_SOLD_OUT);
      await expect(page.getByRole("button", { name: "Ukuran M habis", exact: true })).toHaveAttribute("aria-disabled", "true");
    });

    test(`the homepage grid tile of a sold out product has a 'Sold out' label, in-stock tiles do not (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const soldOutTile = page.getByRole("link", { name: new RegExp(E2E_SOLD_OUT_PRODUCT_NAME) });
      await expect(soldOutTile.getByText("Sold out")).toBeVisible();
      await expect(page.getByText("Sold out")).toHaveCount(1);
    });
  }
});

test.describe("PDP trust row and accordion", () => {
  for (const viewport of VIEWPORTS) {
    test(`trust row has exactly the three items; the return summary is the accordion's first paragraph (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_PRODUCT_SLUG, viewport);
      const trust = page.getByRole("list").filter({ hasText: "Proses Cepat" });
      await expect(trust.getByRole("listitem")).toHaveText(["Pembayaran Aman", "Gratis Ongkir Ke Seluruh Indonesia", "Proses Cepat"]);
      await expect(page.getByText(E2E_RETURN_POLICY_SUMMARY)).toHaveCount(0);

      await page.getByRole("button", { name: "Pengiriman & Pengembalian" }).click();
      const summary = page.getByTestId("return-policy-summary");
      await expect(summary).toHaveText(E2E_RETURN_POLICY_SUMMARY);
      // First paragraph of the panel, before the existing shipping/returns links.
      const panel = summary.locator("xpath=ancestor::div[@role='region']");
      await expect(panel.locator("p").first()).toHaveText(E2E_RETURN_POLICY_SUMMARY);
      await expect(panel.getByRole("link", { name: "Lihat kebijakan pengiriman" })).toBeVisible();
      // Free shipping nationwide: no copy implying the customer pays for or calculates shipping.
      await expect(panel.getByText("Gratis ongkir ke seluruh Indonesia.")).toBeVisible();
      await expect(page.getByText(/Ongkos kirim dihitung/)).toHaveCount(0);
    });

    test(`"Panduan ukuran" opens the closed Ukuran accordion, lands on the size chart heading and focuses it (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_PRODUCT_SLUG, viewport);
      const ukuran = page.getByRole("button", { name: "Ukuran", exact: true });
      await expect(ukuran).toHaveAttribute("aria-expanded", "false");

      await page.getByRole("link", { name: "Panduan ukuran" }).click();

      await expect(ukuran).toHaveAttribute("aria-expanded", "true");
      const heading = page.getByRole("heading", { name: "Panduan ukuran" });
      await expect(heading).toBeFocused();
      // Landed in view, below the 56px sticky header, with no hash jump left in the URL.
      await expect.poll(async () => (await heading.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(56);
      await expect(heading).toBeInViewport();
      expect(new URL(page.url()).hash).toBe("");
      // Exactly on the chart: once the smooth scroll settles, the heading sits at its scroll margin
      // (scroll-mt-20, 80px), where an instant scrollIntoView would put it, so the scroll ran
      // against the final, fully open layout. Desktop included, despite the sticky purchase
      // column. Read-only until the smooth scroll has stopped (a scroll call would cancel it).
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const before = window.scrollY;
            await new Promise((resolve) => setTimeout(resolve, 150));
            return window.scrollY === before;
          }),
        )
        .toBe(true);
      const landing = await heading.evaluate((element) => {
        const settled = element.getBoundingClientRect().top;
        element.scrollIntoView({ behavior: "instant", block: "start" });
        return { settled, target: element.getBoundingClientRect().top };
      });
      expect(Math.abs(landing.settled - landing.target)).toBeLessThanOrEqual(1);
      expect(Math.round(landing.settled)).toBe(80);

      // Already open: clicking again keeps it open and focuses the heading again.
      await page.getByRole("link", { name: "Panduan ukuran" }).click();
      await expect(ukuran).toHaveAttribute("aria-expanded", "true");
      await expect(heading).toBeFocused();
    });
  }

  test("with reduced motion the size chart is reached too", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPdp(page, E2E_PRODUCT_SLUG, VIEWPORTS[0]!);
    await page.getByRole("link", { name: "Panduan ukuran" }).click();
    await expect(page.getByRole("heading", { name: "Panduan ukuran" })).toBeFocused();
    await expect(page.getByRole("heading", { name: "Panduan ukuran" })).toBeInViewport();
  });
});

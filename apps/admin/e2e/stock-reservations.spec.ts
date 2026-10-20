import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_RESERVATION_FREE_SKU,
  E2E_RESERVATION_HELD_SKU,
  E2E_RESERVATION_ORDER_NO,
  E2E_RESERVATION_PRODUCT_NAME,
  E2E_STOCK_RESERVATIONS_EMAIL,
} from "./global-setup";

// docs/plans/cart-checkout.md session 4: the read-only "Dipesan" figure for pieces held by unpaid
// web checkout orders. global-setup.ts seeds one product: E2E-DIPESAN-M has 5 physical pcs, 2 held
// by an active hold and 2 by an expired one (which must not count); E2E-DIPESAN-L has no hold.
// The SKU page's hold list renders two layouts (CardList for phones, TableContainer for desktop),
// so everything is asserted at 390px AND at the project's default 1280px (CLAUDE.md).

const LAYOUTS = [
  { label: "390px", width: 390, height: 844, rowTag: "li", hiddenRowTag: "tr" },
  { label: "1280px", width: 1280, height: 800, rowTag: "tr", hiddenRowTag: "li" },
] as const;

function skuRowOnOverview(page: Page, sku: string) {
  return page.getByRole("link").filter({ hasText: sku });
}

for (const layout of LAYOUTS) {
  test(`stock shows Dipesan for an active web checkout hold and keeps the physical count, at ${layout.label}`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await loginAs(page, E2E_STOCK_RESERVATIONS_EMAIL);

    // Overview: physical stock unchanged (5), the hold shown next to it. The expired hold does not
    // count, so it reads 2, not 4. A SKU without a hold looks as it always did.
    await page.goto(`/stock?q=${encodeURIComponent(E2E_RESERVATION_PRODUCT_NAME)}`);
    const heldRow = skuRowOnOverview(page, E2E_RESERVATION_HELD_SKU);
    await expect(heldRow).toBeVisible();
    await expect(heldRow).toContainText("5");
    await expect(heldRow.getByTestId("sku-reserved-qty")).toHaveText("Dipesan 2");
    const freeRow = skuRowOnOverview(page, E2E_RESERVATION_FREE_SKU);
    await expect(freeRow).toBeVisible();
    await expect(freeRow.getByTestId("sku-reserved-qty")).toHaveCount(0);

    // SKU detail: the holding order, its quantity and expiry; the physical figure stays 5 pcs.
    await heldRow.click();
    await expect(page).toHaveURL(new RegExp(`/stock/${E2E_RESERVATION_HELD_SKU}$`));
    await expect(page.getByText("5 pcs", { exact: true })).toBeVisible();
    const section = page.getByTestId("stock-reservation-section");
    await expect(section.getByRole("heading", { name: "Ditahan untuk pesanan web" })).toBeVisible();
    await expect(section).toContainText("Dipesan 2 pcs");
    const holdRow = section.locator(layout.rowTag).filter({ hasText: E2E_RESERVATION_ORDER_NO });
    await expect(holdRow).toBeVisible();
    await expect(holdRow).toContainText("2");
    await expect(section.locator(layout.hiddenRowTag).filter({ hasText: E2E_RESERVATION_ORDER_NO }).first()).toBeHidden();
    await expect(section.getByText("ORD-E2E-DIPESAN-EXPIRED")).toHaveCount(0);
    await expect(holdRow.getByRole("link", { name: E2E_RESERVATION_ORDER_NO })).toHaveAttribute("href", /^\/orders\/[0-9a-f-]+$/);

    // A SKU without a hold has no Dipesan section at all.
    await page.goto(`/stock/${E2E_RESERVATION_FREE_SKU}`);
    await expect(page.getByRole("heading", { name: E2E_RESERVATION_FREE_SKU })).toBeVisible();
    await expect(page.getByTestId("stock-reservation-section")).toHaveCount(0);

    // Count sheet: held pieces are still on the shelf, so they are counted; "Sistem" is physical.
    await page.goto(`/stock?q=${encodeURIComponent(E2E_RESERVATION_PRODUCT_NAME)}`);
    await page.getByRole("link", { name: "Hitung stok" }).click();
    await expect(page).toHaveURL(/\/stock\/count\/[0-9a-f-]+$/);
    await expect(page.getByTestId("count-reserved-note")).toHaveText(
      "Ada barang yang sedang dipesan dan menunggu pembayaran. Barangnya masih di rak, jadi tetap ikut dihitung.",
    );
    const reservedLines = page.getByTestId("count-reserved-qty");
    await expect(reservedLines).toHaveCount(1);
    await expect(reservedLines).toHaveText("Dipesan: 2 pcs (tetap dihitung)");
    await expect(page.getByText(`${E2E_RESERVATION_HELD_SKU} · Sistem: 5`)).toBeVisible();
  });
}

import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_ORDERS_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";

test("a staffer creates a manual order, stock decreases, then cancels it and stock is restored", async ({ page }) => {
  // Mobile-first per docs/SPEC.md (Orders is a daily-use, mobile-first admin page).
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, E2E_ORDERS_EMAIL);
  const unique = Date.now();

  // 1. Fixtures: a fabric, a product, and one M-size variant — same shape as
  // production-and-stock.spec.ts's own setup.
  const fabricName = `E2E Bahan Pesanan ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Pesanan E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  const code = await page.getByLabel("Kode produk").inputValue();
  await page.getByRole("switch", { name: "Aktif" }).click(); // keep inactive so the variant below comes in active
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
  await page.getByRole("checkbox", { name: /Sage/ }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

  // 2. Seed finished-goods stock: purchase 10 yards of fabric for Rp 1.000.000 (avg Rp 100.000/
  // yard), then a production batch producing 5 pcs — HPP/pcs = 1.000.000 / 5 = Rp 200.000 (no
  // accessories/extra costs on this product, so fabric cost is the whole HPP).
  await page.goto("/purchases/new");
  await page.locator("#purchase-type").selectOption({ label: "Kain" });
  await page.locator("#purchase-item").selectOption({ label: fabricName });
  await page.locator("#purchase-qty").fill("10");
  await page.locator("#purchase-amount").fill("1.000.000");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+$/);

  await page.goto("/production/new");
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("10");
  await expect(page.getByText("Rp 1.000.000")).toBeVisible(); // the live fabric-cost estimate
  await page.getByLabel("M", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]+$/);

  await page.getByRole("button", { name: "Posting ke stok" }).click();
  await page.getByRole("button", { name: "Posting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Posting ke stok" })).toHaveCount(0, { timeout: 15_000 });

  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("5 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 3. Manual order entry: 2 pcs of this SKU, offline channel, starting at "Siap Kirim" (to_ship)
  // — stock decrements immediately at creation.
  await page.goto("/orders/new");
  await page.locator("#order-channel").selectOption({ label: "Offline" });
  // #order-date defaults to today (Asia/Jakarta) — left as-is, same convention
  // production-and-stock.spec.ts follows for its own default-filled date field.
  // By id, not getByLabel("M") — the picker lists EVERY active SKU across every product ever
  // created in this shared e2e database, so several rows can share the "M" size label; the id is
  // unambiguous.
  await page.locator(`#qty-${sku}`).fill("2");
  await page.getByRole("button", { name: "Simpan pesanan" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/, { timeout: 15_000 });
  const orderUrl = page.url();

  // 4. The order detail shows "Siap Kirim" and the snapshotted HPP (Rp 200.000/pcs, from the
  // batch posted above) — this session has finance.view_profit, so cost isn't stripped.
  await expect(page.getByText("Siap Kirim")).toBeVisible();
  await expect(page.getByText("HPP Rp 200.000/pcs")).toBeVisible();

  // 5. Finished-goods stock decreased by exactly the ordered qty (5 - 2 = 3).
  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("3 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 6. Cancel the order — stock must be restored to exactly its pre-order level (5), and the
  // order's status badge reflects the cancellation.
  await page.goto(orderUrl);
  await page.getByRole("button", { name: "Dibatalkan" }).click();
  // The button itself reads "Dibatalkan" too (the transition option) — waiting for it to
  // disappear (cancelled is terminal, so StatusActions renders nothing once it lands) is the
  // unambiguous signal the transition actually completed, not just that the click fired. (Next's
  // own always-present route-announcer element is also role="alert", so that role alone isn't a
  // usable "no error" signal here.)
  await expect(page.getByRole("button", { name: "Dibatalkan" })).toHaveCount(0, { timeout: 15_000 });

  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("5 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });
});

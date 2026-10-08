import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_PRODUCTION_STOCK_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";

test("a staffer creates a cost component, a draft batch with yards and an extra-cost line, posts it, sees stock increase, adjusts it down, then runs a stock count", async ({
  page,
}) => {
  // Mobile-first per docs/SPEC.md (Stock/Production are daily-use, mobile-first admin pages) —
  // this whole flow runs at 390x844, not only a final assertion.
  await page.setViewportSize({ width: 390, height: 844 });
  // A dedicated fixture, not owner/super_admin — see global-setup.ts's comment: both of those
  // are already used right up to the 5-per-5-minutes OTP send throttle across the rest of this
  // suite, so a 6th login on either tips it over.
  await loginAs(page, E2E_PRODUCTION_STOCK_EMAIL);
  const unique = Date.now();

  // 1. Fixtures: a fabric, a product (created inactive so its variant comes in active — same
  // reasoning as products.spec.ts), and one M-size variant.
  const fabricName = `E2E Bahan Produksi ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Produksi E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  const code = await page.getByLabel("Kode produk").inputValue();
  await page.getByRole("switch", { name: "Aktif" }).click(); // keep inactive so the variant below comes in active
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
  const productId = page.url().split("/products/")[1]!;

  await page.getByRole("checkbox", { name: /Sage/ }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

  // 2. Create a cost component on the management page — picked by the batch form below.
  const componentName = `E2E Kancing ${unique}`;
  await page.goto("/production/cost-components/new");
  await page.locator("#component-name").fill(componentName);
  await page.locator("#component-price").fill("2.000");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/production\/cost-components$/);
  await expect(page.getByText(componentName)).toBeVisible();

  // 3. Create a production draft: fabric yards (not roll count), a manual fabric cost (this
  // fabric has no price on file, so there's nothing to prefill from), and one extra-cost line
  // using the component just created.
  await page.goto("/production/new");
  // By id, not getByLabel — same required-asterisk reasoning as #product-fabric elsewhere.
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("10");
  await page.locator("#batch-fabric-cost").fill("500.000");
  await page.getByRole("button", { name: "+ Tambah biaya" }).click();
  await page.locator("#extra-cost-component-0").selectOption({ label: componentName });
  await page.locator("#extra-cost-qty-0").fill("5");
  // Unit price is prefilled from the component's default (2.000) — left as-is.
  await page.getByLabel("M", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]+$/);

  // 4. Post it — stock must not move until this confirmed action.
  await page.getByRole("button", { name: "Posting ke stok" }).click();
  await page.getByRole("button", { name: "Posting", exact: true }).click();
  // Posted batches render the read-only view (no post/delete controls at all) — unambiguous
  // unlike "Diposting", which also appears as a field label in the read-only view itself.
  await expect(page.getByRole("button", { name: "Posting ke stok" })).toHaveCount(0, { timeout: 15_000 });

  // 5. The posted detail shows the extra-cost line's breakdown: componentName, quantity, unit
  // and unit price together are a unique string (unlike "Rp 10.000" alone, which also appears
  // in the "Biaya lain" subtotal right above — asserting on the combined line avoids a
  // Playwright strict-mode violation from matching both).
  await expect(page.getByText(`${componentName} (5 pcs × Rp 2.000)`)).toBeVisible();

  // 6. Stock increased by exactly the posted quantity.
  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("5 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 7. Manual adjustment down, with a reason — stock decreases accordingly.
  await page.getByRole("button", { name: "Sesuaikan stok" }).click();
  await page.locator("#adjust-delta").fill("-2");
  await page.locator("#adjust-reason").selectOption({ label: "Rusak/cacat" });
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByText("3 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 8. Stock count (opname): set the physical count to something different (10) — creates one
  // more adjustment, bringing the SKU to 10.
  await page.goto(`/stock/count/${productId}`);
  await page.locator(`#count-${sku}`).fill("10");
  const saveCountButton = page.getByRole("button", { name: "Simpan hasil hitung" });
  await saveCountButton.click();
  // `disabled` alone is ambiguous here — it's true BOTH while the save is in flight (loading)
  // AND after it succeeds (isDirty becomes false) — so checking for it right after click can
  // pass WHILE the mutation is still pending, racing the next navigation. Wait for the in-flight
  // state (aria-busy) to clear first, THEN check the post-success disabled state.
  await expect(saveCountButton).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(saveCountButton).toBeDisabled();

  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("10 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });
});

import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_PRODUCTION_STOCK_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";

test("a staffer purchases fabric and an accessory, sets a recipe, creates a draft batch with an extra-cost line, posts it, sees stock and HPP, adjusts it down, then runs a stock count", async ({
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

  // 2. Raw-material inventory: a size-independent accessory, purchased via /purchases, then
  // wired into the product's recipe at 1/pcs.
  const accessoryName = `E2E Kancing ${unique}`;
  await page.goto("/accessories/new");
  await page.locator("#accessory-name").fill(accessoryName);
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/accessories\/[0-9a-f-]+$/);
  const accessoryId = page.url().split("/accessories/")[1]!;

  await page.goto(`/products/${productId}`);
  await page.getByRole("button", { name: "+ Tambah baris" }).click();
  await page.locator("#recipe-accessory-0").selectOption({ label: accessoryName });
  await page.locator("#recipe-qty-0").fill("1");
  await page.getByRole("button", { name: "Simpan resep" }).click();
  // No navigation on save (router.refresh() only) — wait for the button's loading state to
  // clear, confirming the round-trip finished, before moving on.
  await expect(page.getByRole("button", { name: "Simpan resep" })).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  // 3. Purchase fabric stock (10 yards for Rp 1.000.000 -> avg Rp 100.000/yard) and accessory
  // stock (10 pcs for Rp 20.000 -> avg Rp 2.000/pcs) via /purchases — the batch below consumes
  // exactly 10 yards and (1/pcs recipe x 5 pcs line) exactly 5 accessory pcs.
  await page.goto("/purchases/new");
  await page.locator("#purchase-type").selectOption({ label: "Kain" });
  await page.locator("#purchase-item").selectOption({ label: fabricName });
  await page.locator("#purchase-qty").fill("10");
  await page.locator("#purchase-amount").fill("1.000.000");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+$/);

  await page.goto("/purchases/new");
  await page.locator("#purchase-type").selectOption({ label: "Aksesoris" });
  await page.locator("#purchase-item").selectOption({ label: accessoryName });
  await page.locator("#purchase-qty").fill("10");
  await page.locator("#purchase-amount").fill("20.000");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+$/);

  // 4. Create a cost component (variable, per pcs) on the management page — picked by the batch
  // form below.
  const componentName = `E2E Ongkos ${unique}`;
  await page.goto("/production/cost-components/new");
  await page.locator("#component-name").fill(componentName);
  await page.locator("#component-price").fill("2.000");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/production\/cost-components$/);
  // Renders twice in the DOM (a mobile card and a desktop table row, one hidden via CSS per
  // breakpoint; see cost-component-list.tsx) — this test runs at the 390px viewport set above.
  await expect(page.locator(`:text-is("${componentName}"):visible`)).toBeVisible();

  // 5. Create a production draft: fabric yards (fabric cost is now a computed ESTIMATE, never
  // hand-typed) and one extra-cost line using the component just created — its quantity is
  // computed server-side from the batch's total pcs, never typed either.
  await page.goto("/production/new");
  // By id, not getByLabel — same required-asterisk reasoning as #product-fabric elsewhere.
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("10");
  await expect(page.getByText("Rp 1.000.000")).toBeVisible(); // the live fabric-cost estimate
  await page.getByRole("button", { name: "+ Tambah biaya" }).click();
  await page.locator("#extra-cost-component-0").selectOption({ label: componentName });
  // Unit price is prefilled from the component's default (2.000) — left as-is; there is no
  // quantity field to fill (it's computed from the batch's total pcs below).
  await page.getByLabel("M", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]+$/);

  // 6. "Kebutuhan aksesoris" shows the resolved recipe need (1/pcs x 5 pcs = 5) against current
  // stock (10) — no shortage yet.
  await expect(page.getByText(`Butuh 5 pcs · Stok 10 pcs`)).toBeVisible();

  // 7. Post it — stock must not move until this confirmed action.
  await page.getByRole("button", { name: "Posting ke stok" }).click();
  await page.getByRole("button", { name: "Posting", exact: true }).click();
  // Posted batches render the read-only view (no post/delete controls at all) — unambiguous
  // unlike "Diposting", which also appears as a field label in the read-only view itself.
  await expect(page.getByRole("button", { name: "Posting ke stok" })).toHaveCount(0, { timeout: 15_000 });

  // 8. The posted detail shows the full cost breakdown: Kain (fabric, computed from the purchase
  // average), Aksesoris (the accessory consumed), Biaya variabel (the extra-cost line), and
  // HPP/pcs = ceil((1.000.000 + 5*2.000 + 5*2.000) / 5) = 204.000.
  await expect(page.getByText("Rp 1.000.000")).toBeVisible(); // Kain
  await expect(page.getByText(`${accessoryName} (5 pcs)`)).toBeVisible();
  await expect(page.getByText(`${componentName} (5 pcs × Rp 2.000)`)).toBeVisible();
  await expect(page.getByText("HPP/pcs")).toBeVisible();
  // "Rp 204.000" appears twice (the HPP/pcs figure itself, and again next to its Batas HPP
  // badge below) — .first() is enough to confirm the value renders at all.
  await expect(page.getByText("Rp 204.000").first()).toBeVisible();

  // 9. Finished-goods stock increased by exactly the posted quantity.
  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("5 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 10. Accessory stock decreased by exactly what the recipe + batch consumed (10 - 5 = 5).
  await page.goto(`/accessories/${accessoryId}`);
  await expect(page.getByText("5 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 11. Manual adjustment down, with a reason — finished-goods stock decreases accordingly.
  await page.goto(`/stock/${sku}`);
  await page.getByRole("button", { name: "Sesuaikan stok" }).click();
  await page.locator("#adjust-delta").fill("-2");
  await page.locator("#adjust-reason").selectOption({ label: "Rusak/cacat" });
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByText("3 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 12. Stock count (opname): set the physical count to something different (10) — creates one
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

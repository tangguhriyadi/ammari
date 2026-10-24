import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { createSupplier, purchaseAndReceiveAll } from "./helpers/purchase";
import { postBatch, receiveAllBatchOutput } from "./helpers/production";
import { E2E_PRODUCTION_STOCK_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";
import { addVariants, createProductDraft, openProductStep } from "./helpers/product";

test("a staffer purchases fabric and an accessory, sets a recipe, creates a draft batch with an extra-cost line, posts it (no stock yet), receives the output in two parts, sees stock and HPP, adjusts it down, then runs a stock count", async ({
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

  // 1. Fixtures: a fabric, a product (left inactive; its variant is created active regardless),
  // and one M-size variant.
  const fabricName = `E2E Bahan Produksi ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Produksi E2E ${unique}`;
  const { productId, code } = await createProductDraft(page, { name: productName, fabricName, active: false }); // product left inactive; variants are created active either way
  await addVariants(page, /Sage/, ["M"]);
  const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

  // 2. Raw-material inventory: a size-independent accessory, purchased via /purchases, then
  // wired into the product's recipe at 1/pcs.
  const accessoryName = `E2E Kancing ${unique}`;
  await page.goto("/accessories/new");
  await page.locator("#accessory-name").fill(accessoryName);
  await page.getByRole("button", { name: "Simpan" }).click();
  await openCreated(page, "/accessories");
  const accessoryId = page.url().split("/accessories/")[1]!;

  await openProductStep(page, productId, "aksesoris");
  await page.getByRole("button", { name: "+ Tambah baris" }).click();
  await page.locator("#recipe-accessory-0").selectOption({ label: accessoryName });
  await page.locator("#recipe-qty-0").fill("1");
  await page.getByRole("button", { name: "Simpan resep" }).click();
  // No navigation on save (router.refresh() only) — wait for the button's loading state to
  // clear, confirming the round-trip finished, before moving on.
  await expect(page.getByRole("button", { name: "Simpan resep" })).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  // 3. Purchase fabric stock (10 yards for Rp 1.000.000 -> avg Rp 100.000/yard) and accessory
  // stock (10 pcs for Rp 20.000 -> avg Rp 2.000/pcs) via one purchase document, received in full — the batch below consumes
  // exactly 10 yards and (1/pcs recipe x 5 pcs line) exactly 5 accessory pcs.
  await purchaseAndReceiveAll(page, [
    { type: "Kain", itemName: fabricName, qty: "10", amount: "1.000.000" },
    { type: "Aksesoris", itemName: accessoryName, qty: "10", amount: "20.000" },
  ]);

  // 4. Two suppliers (plan S2, D9): the tailor who is the cost component's default, and a second
  // one the batch line below overrides it with.
  const tailorName = `E2E Penjahit ${unique}`;
  const overrideName = `E2E Penjahit Pengganti ${unique}`;
  await createSupplier(page, tailorName);
  await createSupplier(page, overrideName);

  // 4b. Create a cost component (variable, per pcs) on the management page, with the tailor as
  // its default supplier — picked by the batch form below.
  const componentName = `E2E Ongkos ${unique}`;
  await page.goto("/production/cost-components/new");
  await page.locator("#component-name").fill(componentName);
  await page.locator("#component-price").fill("2.000");
  await page.locator("#component-supplier").selectOption({ label: tailorName });
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/production\/cost-components$/);
  // Renders twice in the DOM (a mobile card and a desktop table row, one hidden via CSS per
  // breakpoint; see cost-component-list.tsx) — this test runs at the 390px viewport set above.
  await expect(page.locator(`:text-is("${componentName}"):visible`)).toBeVisible();
  // The default supplier shows on the list in BOTH layouts (CLAUDE.md: list pages are asserted at
  // 390px and 1280px): the phone card, then the desktop table's own column.
  await expect(page.locator("li").filter({ hasText: componentName }).getByText(`Supplier: ${tailorName}`)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("tr").filter({ hasText: componentName }).getByRole("cell", { name: tailorName, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

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
  // The line's supplier is prefilled from the component's default too, then overridden per line.
  await expect(page.locator("#extra-cost-supplier-0 option:checked")).toHaveText(tailorName);
  await page.locator("#extra-cost-supplier-0").selectOption({ label: overrideName });
  await page.getByLabel("M", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await openCreated(page, "/production");

  // 6. "Kebutuhan aksesoris" shows the resolved recipe need (1/pcs x 5 pcs = 5) against current
  // stock (10) — no shortage yet.
  await expect(page.getByText(`Butuh 5 pcs · Stok 10 pcs`)).toBeVisible();

  // 7. Post it. Since S4 (docs/plans/suppliers-goods-receipt.md) posting consumes material and
  // freezes HPP but adds NO finished-goods stock.
  await postBatch(page);
  const batchUrl = page.url();
  const batchNo = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();

  // 8. The posted detail shows the full cost breakdown: Kain (fabric, computed from the purchase
  // average), Aksesoris (the accessory consumed), Biaya variabel (the extra-cost line), and
  // HPP/pcs = ceil((1.000.000 + 5*2.000 + 5*2.000) / 5) = 204.000.
  await expect(page.getByText("Rp 1.000.000")).toBeVisible(); // Kain
  await expect(page.getByText(`${accessoryName} (5 pcs)`)).toBeVisible();
  await expect(page.getByText(`${componentName} (5 pcs × Rp 2.000)`)).toBeVisible();
  // The line's own supplier (the override, not the component's default) is snapshotted onto it.
  await expect(page.getByText(`Supplier: ${overrideName}`)).toBeVisible();
  await expect(page.getByText(`Supplier: ${tailorName}`)).toHaveCount(0);
  await expect(page.getByText("HPP/pcs")).toBeVisible();
  // "Rp 204.000" appears twice (the HPP/pcs figure itself, and again next to its Batas HPP
  // badge below) — .first() is enough to confirm the value renders at all.
  await expect(page.getByText("Rp 204.000").first()).toBeVisible();
  // ...and the "Hasil produksi" panel waits for the output.
  await expect(page.getByRole("heading", { name: "Hasil produksi" })).toBeVisible();
  await expect(page.getByText("Belum diterima", { exact: true })).toBeVisible();

  // 9a. Finished-goods stock did NOT move at posting.
  await page.goto(`/stock/${sku}`);
  // .first(): the sellable figure; the "Barang cacat" section below it (S5b) shows its own "0 pcs".
  await expect(page.getByText("0 pcs", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  // 9b. The stock-count guard warns about the posted-but-unreceived batch, at 390px and 1280px,
  // next to the standing "don't count defects" instruction.
  await page.goto(`/stock/count/${productId}`);
  const warning = page.getByRole("note");
  await expect(warning.getByText("Ada hasil produksi yang belum diterima")).toBeVisible();
  await expect(warning.getByRole("link", { name: batchNo })).toBeVisible();
  await expect(warning.getByText(/Belum diterima · sisa 5 pcs/)).toBeVisible();
  await expect(page.getByText("Jangan hitung barang cacat, hitung hanya barang yang bisa dijual.")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(warning.getByRole("link", { name: batchNo })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  // 9c. Partial receipt: 2 of the 5 pcs. Stock rises by exactly 2.
  await warning.getByRole("link", { name: batchNo }).click();
  await expect(page).toHaveURL(batchUrl);
  await page.getByRole("link", { name: "Terima hasil" }).click();
  await expect(page).toHaveURL(/\/receive$/);
  const outputInput = page.getByLabel(`${productName} · Sage · M`);
  await expect(outputInput).toHaveValue("5"); // prefilled with what is left
  await expect(page.getByText("Rencana 5 · Diterima 0 · Sisa 5 pcs")).toBeVisible();
  // Over-receipt is blocked before it reaches the server, with a clear message.
  await outputInput.fill("6");
  await expect(page.getByText("Melebihi sisa batch (5 pcs).")).toBeVisible();
  await outputInput.fill("2");
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page).toHaveURL(batchUrl, { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText("berhasil dicatat");
  await expect(page.getByText("Diterima sebagian", { exact: true })).toBeVisible();
  await expect(page.getByTestId("receipt-row")).toHaveCount(1);

  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("2 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // The production list shows the receipt status in both layouts.
  await page.goto("/production");
  await expect(page.locator("li").filter({ hasText: batchNo }).getByText("Diterima sebagian")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("tr").filter({ hasText: batchNo }).getByText("Diterima sebagian")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  // The count-page warning now shows what is still outstanding.
  await page.goto(`/stock/count/${productId}`);
  await expect(page.getByRole("note").getByText(/Diterima sebagian · sisa 3 pcs/)).toBeVisible();

  // 9d. Receive the rest: complete. Stock = all 5 posted pcs, and the warning is gone (the
  // standing instruction stays).
  await page.goto(batchUrl);
  await receiveAllBatchOutput(page);
  await expect(page.getByTestId("receipt-row")).toHaveCount(2);
  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("5 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.goto(`/stock/count/${productId}`);
  await expect(page.getByText("Jangan hitung barang cacat, hitung hanya barang yang bisa dijual.")).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0);

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
  // A successful save redirects to /stock and raises the success toast.
  await expect(page).toHaveURL(/\/stock$/, { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText("Hitung stok berhasil disimpan");

  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("10 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("an inactive supplier still shows on the cost component that defaults to it, but is never offered for a new batch line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, E2E_PRODUCTION_STOCK_EMAIL);
  const unique = Date.now();

  const supplierName = `E2E Penjahit Lama ${unique}`;
  await createSupplier(page, supplierName);

  const componentName = `E2E Ongkos Lama ${unique}`;
  await page.goto("/production/cost-components/new");
  await page.locator("#component-name").fill(componentName);
  await page.locator("#component-supplier").selectOption({ label: supplierName });
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/production\/cost-components$/);

  // Deactivate the supplier (the phone card's switch on /suppliers).
  await page.goto("/suppliers");
  const supplierCard = page.locator("li").filter({ hasText: supplierName });
  await supplierCard.getByRole("switch").click();
  await expect(supplierCard.getByText("Nonaktif", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Still displayed, marked, on the component's list (both layouts) and its edit form.
  await page.goto("/production/cost-components");
  await expect(page.locator("li").filter({ hasText: componentName }).getByText(`Supplier: ${supplierName} (nonaktif)`)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(
    page.locator("tr").filter({ hasText: componentName }).getByRole("cell", { name: `${supplierName} (nonaktif)`, exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.locator("li").filter({ hasText: componentName }).getByRole("link").click();
  await expect(page.locator("#component-supplier option:checked")).toHaveText(`${supplierName} (nonaktif)`);

  // A new batch line using that component is NOT prefilled with it, and can't pick it at all.
  await page.goto("/production/new");
  await page.getByRole("button", { name: "+ Tambah biaya" }).click();
  await page.locator("#extra-cost-component-0").selectOption({ label: componentName });
  await expect(page.locator("#extra-cost-supplier-0 option:checked")).toHaveText("Tanpa supplier");
  await expect(page.locator("#extra-cost-supplier-0 option").filter({ hasText: supplierName })).toHaveCount(0);
});

test("a batch whose remaining output will never arrive is short-closed with a reason: stock keeps what was received, HPP stays, the unabsorbed value shows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, E2E_PRODUCTION_STOCK_EMAIL);
  const unique = Date.now();

  const fabricName = `E2E Bahan Tutup ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Tutup E2E ${unique}`;
  const { productId, code } = await createProductDraft(page, { name: productName, fabricName, active: false }); // product left inactive; variants are created active either way
  await addVariants(page, /Sage/, ["M"]);
  const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

  // 2 yards for Rp 200.000, a batch of 4 pcs using both: HPP/pcs = 200.000 / 4 = Rp 50.000.
  await purchaseAndReceiveAll(page, [{ type: "Kain", itemName: fabricName, qty: "2", amount: "200.000" }]);
  await page.goto("/production/new");
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("2");
  await page.getByLabel("M", { exact: true }).fill("4");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await openCreated(page, "/production");
  await postBatch(page);
  const batchUrl = page.url();
  const batchNo = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();

  // Receive 1 of the 4.
  await page.getByRole("link", { name: "Terima hasil" }).click();
  await page.getByLabel(`${productName} · Sage · M`).fill("1");
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page).toHaveURL(batchUrl, { timeout: 15_000 });
  await expect(page.getByText("Diterima sebagian", { exact: true })).toBeVisible();

  // Close it: a reason is required.
  await page.getByRole("button", { name: "Tutup batch" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Sisa 3 pcs yang belum diterima tidak akan ditunggu lagi.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Tutup batch" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Alasan wajib diisi.");
  await dialog.getByLabel("Alasan").fill("Sisa kain rusak saat dijahit");
  await dialog.getByRole("button", { name: "Tutup batch" }).click();
  await expect(page.getByRole("status")).toContainText("Batch ditutup");
  await expect(page.getByText("Ditutup", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Sisa kain rusak saat dijahit")).toBeVisible();
  await expect(page.getByRole("link", { name: "Terima hasil" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tutup batch" })).toHaveCount(0);

  // HPP/pcs is unchanged; the 3 pcs that never arrived show as unabsorbed value (3 × 50.000).
  await expect(page.getByText("HPP/pcs")).toBeVisible();
  await expect(page.getByText("Rp 50.000").first()).toBeVisible();
  await expect(page.getByText("Nilai belum terserap", { exact: true })).toBeVisible();
  await expect(page.getByText("Rp 150.000")).toBeVisible();

  // Stock keeps exactly what was received, and the count page no longer warns about the batch.
  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("1 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.goto(`/stock/count/${productId}`);
  await expect(page.getByRole("note")).toHaveCount(0);

  // The production list shows it closed, in both layouts.
  await page.goto("/production");
  await expect(page.locator("li").filter({ hasText: batchNo }).getByText("Ditutup")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("tr").filter({ hasText: batchNo }).getByText("Ditutup")).toBeVisible();
});

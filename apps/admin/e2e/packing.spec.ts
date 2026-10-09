import { expect, test, type Locator } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_PACKING_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";

test("a staffer prints a card and ships one order, then cancelling a second (already-printed) order leaves it out of the packing queue", async ({
  page,
}) => {
  // Mobile-first per docs/SPEC.md (Packing is a daily-use, mobile-first admin page).
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, E2E_PACKING_EMAIL);
  const unique = Date.now();

  // 1. Fixtures: a fabric, a product, and one M-size variant.
  const fabricName = `E2E Bahan Packing ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Packing E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  const code = await page.getByLabel("Kode produk").inputValue();
  await page.getByRole("switch", { name: "Aktif" }).click();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);

  await page.getByRole("checkbox", { name: /Sage/ }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

  // 2. Seed finished-goods stock: 5 pcs via a posted production batch.
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
  await page.locator(`#qty-${sku}`).fill("5");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Posting ke stok" }).click();
  await page.getByRole("button", { name: "Posting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Posting ke stok" })).toHaveCount(0, { timeout: 15_000 });

  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("5 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 3. Two manual orders drawing from the same SKU — A (qty 2) gets printed then shipped, B
  // (qty 1) gets printed then cancelled.
  async function createOrder(qty: string): Promise<{ orderNo: string; url: string }> {
    await page.goto("/orders/new");
    // WhatsApp, not Offline — matches a real bug report exactly (two manual WhatsApp orders
    // that didn't show in the /packing queue; see lib/packing/queries.test.ts's own regression
    // tests for the full investigation).
    await page.locator("#order-channel").selectOption({ label: "WhatsApp" });
    await page.locator(`#qty-${sku}`).fill(qty);
    await page.getByRole("button", { name: "Simpan pesanan" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/, { timeout: 15_000 });
    const orderNo = (await page.locator("h1").textContent())!.trim();
    return { orderNo, url: page.url() };
  }
  const orderA = await createOrder("2");
  const orderB = await createOrder("1");
  const orderANo = orderA.orderNo;
  const orderBNo = orderB.orderNo;

  // 4. Print A's card from the packing queue — first print, no reprint warning expected.
  await page.goto("/packing");
  const cardA = page.locator("li").filter({ hasText: orderANo });
  await expect(cardA.getByText("Belum", { exact: true })).toBeVisible();
  await cardA.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Cetak kartu" }).click();
  await expect(page.getByText("1 kartu siap dicetak")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Tutup" }).click();

  // 5. The queue now shows A's card as printed, and shipping it works.
  await expect(page.locator("li").filter({ hasText: orderANo }).getByText(/^Tercetak/)).toBeVisible({ timeout: 15_000 });
  const cardARefreshed = page.locator("li").filter({ hasText: orderANo });
  await cardARefreshed.getByRole("button", { name: "Tandai dikirim" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Tandai dikirim" }).click();
  await expect(page.locator("li").filter({ hasText: orderANo })).toHaveCount(0, { timeout: 15_000 });

  // 6. Print B's card too, then cancel the ORDER (not ship it) from its own detail page — this
  // exercises transitionOrderStatus's void-the-active-card side effect end to end. (The exact
  // DB-level assertion that the card row itself flips to 'void' is covered by
  // lib/orders/queries.test.ts's own unit test; a cancelled order has no remaining UI surface to
  // re-inspect its card from, since it's no longer in the to_ship queue at all.)
  const cardB = page.locator("li").filter({ hasText: orderBNo });
  await cardB.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Cetak kartu" }).click();
  await expect(page.getByText("1 kartu siap dicetak")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Tutup" }).click();
  await expect(page.locator("li").filter({ hasText: orderBNo }).getByText(/^Tercetak/)).toBeVisible({ timeout: 15_000 });

  await page.goto(orderB.url);
  await page.getByRole("button", { name: "Dibatalkan" }).click();
  await expect(page.getByRole("button", { name: "Dibatalkan" })).toHaveCount(0, { timeout: 15_000 });

  await page.goto("/packing");
  await expect(page.locator("li").filter({ hasText: orderBNo })).toHaveCount(0);
});

test("the packing queue renders correctly on a desktop-width browser: rows visible, no mid-value wrapping, select-all works", async ({
  page,
}) => {
  // No `page.setViewportSize` override here — this runs at the Desktop Chrome project's default
  // viewport (see playwright.config.ts). The real bug report: the server-side log showed
  // `rowCount: 2` on every request, but the browser rendered nothing — `CardList` is `md:hidden`
  // (packages/ui/src/components/Table.tsx) with no `TableContainer` counterpart of its own, so
  // the whole queue vanished above the mobile breakpoint. `<li>` is the mobile `CardList`'s own
  // markup and stays present (just hidden) at this width, so assertions here use `<tr>` — the
  // desktop `TableContainer` row — and `toBeVisible()`, not `toHaveCount()`, since the bug was
  // never about the DOM missing rows.
  await loginAs(page, E2E_PACKING_EMAIL);
  const unique = Date.now();

  const fabricName = `E2E Bahan Packing Desktop ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Dusty");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  // Product with NO photos uploaded — matches the real bug report's product exactly, and rules
  // out a thumbnail-join theory as a confound while this CSS bug is the one under test.
  const productName = `Contoh Gamis Packing Desktop E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  const code = await page.getByLabel("Kode produk").inputValue();
  await page.getByRole("switch", { name: "Aktif" }).click();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);

  await page.getByRole("checkbox", { name: /Dusty/ }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  const sku = generateSku({ code, closure: "front_zip", color: "Dusty", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

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
  await page.locator(`#qty-${sku}`).fill("3");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Posting ke stok" }).click();
  await page.getByRole("button", { name: "Posting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Posting ke stok" })).toHaveCount(0, { timeout: 15_000 });

  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("3 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Two manual WhatsApp orders, status to_ship — the exact real-world shape from the bug report.
  async function createOrder(qty: string): Promise<string> {
    await page.goto("/orders/new");
    await page.locator("#order-channel").selectOption({ label: "WhatsApp" });
    await page.locator(`#qty-${sku}`).fill(qty);
    await page.getByRole("button", { name: "Simpan pesanan" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/, { timeout: 15_000 });
    return (await page.locator("h1").textContent())!.trim();
  }
  const orderANo = await createOrder("1");
  const orderBNo = await createOrder("1");

  await page.goto("/packing");
  const rowA = page.locator("tr").filter({ hasText: orderANo });
  const rowB = page.locator("tr").filter({ hasText: orderBNo });
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  // Card status badge has no "Kartu:" prefix any more — just "Belum" before any print.
  await expect(rowA.getByText("Belum", { exact: true })).toBeVisible();

  // The row's own checkbox is still reachable by its accessible name even though that name is
  // visually hidden (Checkbox's `hideLabel` — packages/ui/src/components/Checkbox.tsx): a
  // sighted user would otherwise see "Pilih ORD-..." duplicated right next to the order number.
  await expect(rowA.getByRole("checkbox", { name: `Pilih ${orderANo}` })).toBeVisible();

  // Nothing wraps mid-value at this width — checked via the computed `white-space` property
  // itself, not a pixel-height heuristic: the header ROW's height is dictated by its tallest
  // cell (the select-all checkbox's own 44px tap target), so a plain boundingBox() comparison
  // on a neighboring cell would be confounded by that, not by actual text wrapping.
  async function assertNoWrap(locator: Locator): Promise<void> {
    await expect(locator).toHaveCSS("white-space", "nowrap");
  }
  await assertNoWrap(page.locator("th", { hasText: "Tanggal" }));
  await assertNoWrap(rowA.getByText(orderANo, { exact: true }));

  // Select-all picks up every visible row, and the bulk-action buttons reflect the count.
  const selectAll = page.getByRole("checkbox", { name: "Pilih semua" });
  await selectAll.check();
  await expect(page.getByRole("button", { name: "Cetak kartu (2)" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Pilih ${orderANo}` })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: `Pilih ${orderBNo}` })).toBeChecked();
  await selectAll.uncheck();
  await expect(page.getByRole("button", { name: "Cetak kartu" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Pilih ${orderANo}` })).not.toBeChecked();
});

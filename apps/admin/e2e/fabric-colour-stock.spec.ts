import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { createPurchase, createSupplier } from "./helpers/purchase";
import { E2E_FABRIC_COLOUR_EMAIL } from "./global-setup";

// docs/plans/fabric-colour-stock.md sessions S2 (purchase lines per colour), S3 (receiving, undo,
// defects and exchange per colour) and S4 (stock pages and adjustments per colour). Every flow runs at 390px
// AND 1280px (CLAUDE.md's rule): the purchase detail's Barang list renders two independent layouts
// (CardList for phones, TableContainer for desktop), so each pass asserts its own layout's rows
// and that the other layout's rows are hidden.

interface Layout {
  label: string;
  width: number;
  height: number;
  lineRow: string;
  hiddenLineRow: string;
}

const MOBILE: Layout = {
  label: "390px",
  width: 390,
  height: 844,
  lineRow: '[data-testid="purchase-line-card"]',
  hiddenLineRow: '[data-testid="purchase-line-row"]',
};
const DESKTOP: Layout = {
  label: "1280px",
  width: 1280,
  height: 800,
  lineRow: '[data-testid="purchase-line-row"]',
  hiddenLineRow: '[data-testid="purchase-line-card"]',
};

/** Creates a fabric with `colors` on /fabrics/new and returns its detail URL. */
async function createFabric(page: Page, name: string, colors: string[]): Promise<string> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  for (const [index, color] of colors.entries()) {
    if (index > 0) await page.getByRole("button", { name: "+ Tambah warna" }).click();
    await page.getByLabel("Nama warna").nth(index).fill(color);
  }
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
  return page.url();
}

function selectedOption(page: Page, label: string) {
  return page.getByLabel(label, { exact: true }).locator("option:checked");
}

/** The detail page's Barang rows in this viewport's layout: exactly `expected` (fabric colour
 * labels, in order), and the other layout hidden. */
async function expectLines(page: Page, layout: Layout, fabricName: string, expected: string[]): Promise<void> {
  const rows = page.locator(layout.lineRow);
  await expect(rows).toHaveCount(expected.length);
  for (const [index, colorLabel] of expected.entries()) {
    await expect(rows.nth(index)).toContainText(fabricName);
    await expect(rows.nth(index).getByTestId("purchase-line-color")).toHaveText(colorLabel);
  }
  await expect(page.locator(layout.hiddenLineRow).first()).toBeHidden();
}

async function receiptPhoto(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 200, g: 180, b: 170 } } })
    .jpeg()
    .toBuffer();
}

async function runCreateWithColours(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.width}-${Date.now()}`;
  const supplierName = `E2E Pemasok Warna ${marker}`;
  const fabricName = `E2E Marbella Warna ${marker}`;
  await createSupplier(page, supplierName);
  await createFabric(page, fabricName, ["Sage", "Mocca", "Tosca"]);

  await page.goto("/purchases/new");
  await page.locator("#purchase-supplier").selectOption({ label: supplierName });
  await page.getByLabel("Jenis barang 1").selectOption({ label: "Kain" });
  await page.getByLabel("Barang 1", { exact: true }).selectOption({ label: fabricName });
  await expect(page.getByLabel("Warna barang 1", { exact: true })).toBeVisible();

  // Harga/yard first, then "Tambah semua warna": one line per colour (by name), each keeping it.
  await page.getByLabel("Harga per yard barang 1").fill("19.500");
  await page.getByRole("button", { name: "Tambah semua warna barang 1" }).click();
  await expect(page.getByTestId("purchase-line")).toHaveCount(3);
  for (const [index, color] of ["Mocca", "Sage", "Tosca"].entries()) {
    await expect(selectedOption(page, `Warna barang ${index + 1}`)).toHaveText(color);
    await expect(page.getByLabel(`Harga per yard barang ${index + 1}`)).toHaveValue("19.500");
  }
  // Every colour is on the document now: nothing left to add.
  await expect(page.getByRole("button", { name: /^Tambah semua warna/ })).toHaveCount(0);

  // Jumlah × Harga/yard fills Total harga; the footer sums yards per fabric and the document.
  await page.getByLabel("Jumlah barang 1").fill("10");
  await page.getByLabel("Jumlah barang 2").fill("8");
  await page.getByLabel("Jumlah barang 3").fill("5");
  await expect(page.getByLabel("Total harga barang 1")).toHaveValue("195.000");
  await expect(page.getByLabel("Total harga barang 2")).toHaveValue("156.000");
  await expect(page.getByLabel("Total harga barang 3")).toHaveValue("97.500");
  const totals = page.getByTestId("purchase-form-totals");
  await expect(totals).toContainText(`${fabricName}23.00 yard · Rp 448.500`);
  await expect(totals).toContainText("Total pesanan");
  await expect(totals).toContainText("Rp 448.500");

  // A 4th line of the same fabric without a colour is refused before anything is sent.
  await page.getByRole("button", { name: "+ Tambah barang" }).click();
  await page.getByLabel("Jenis barang 4").selectOption({ label: "Kain" });
  await page.getByLabel("Barang 4", { exact: true }).selectOption({ label: fabricName });
  await page.getByLabel("Jumlah barang 4").fill("1");
  await page.getByLabel("Total harga barang 4").fill("1");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.locator('form [role="alert"]')).toHaveText(`Pilih warna untuk ${fabricName}.`);
  await page.getByRole("button", { name: "Hapus barang 4" }).click();

  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await openCreated(page, "/purchases", supplierName);
  const purchaseUrl = page.url();
  await expectLines(page, layout, fabricName, ["Mocca", "Sage", "Tosca"]);

  // Edit: remove Tosca, change Sage, save; the detail follows.
  await page.getByRole("link", { name: "Ubah pesanan" }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(selectedOption(page, "Warna barang 3")).toHaveText("Tosca");
  await page.getByRole("button", { name: "Hapus barang 3" }).click();
  await page.getByLabel("Jumlah barang 2").fill("12");
  await page.getByLabel("Total harga barang 2").fill("234.000");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases$/, { timeout: 15_000 });
  await page.goto(purchaseUrl);
  await expectLines(page, layout, fabricName, ["Mocca", "Sage"]);
  await expect(page.locator(layout.lineRow).nth(1)).toContainText("12.00 yard");
}

/** PO-202611-001's case: a colourless line ordered (and partly paid) before the fabric had active
 * colours; once it has, the owner replaces it with per-colour lines covering at least the DP. */
async function runLegacyLineEdit(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.width}-${Date.now()}`;
  const supplierName = `E2E Pemasok Lama ${marker}`;
  const fabricName = `E2E Marbella Lama ${marker}`;
  await createSupplier(page, supplierName);
  const fabricUrl = await createFabric(page, fabricName, ["Sage"]);
  // No active colour → the purchase line is "Tanpa warna", exactly like data from before S2.
  await page.getByRole("switch", { name: "Aktif" }).click();
  await expect(page.getByRole("switch", { name: "Aktif" })).toHaveAttribute("aria-checked", "false");

  await createPurchase(page, supplierName, [{ type: "Kain", itemName: fabricName, qty: "30", amount: "585.000" }]);
  const purchaseUrl = page.url();
  await expectLines(page, layout, fabricName, ["Tanpa warna"]);

  // DP Rp 300.000.
  await page.getByRole("button", { name: "Catat pembayaran" }).click();
  const dialog = page.getByRole("dialog", { name: "Catat pembayaran" });
  await dialog.getByLabel("Jumlah").fill("300.000");
  await dialog.locator('input[type="file"]').setInputFiles({ name: `dp-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto() });
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText("dicatat", { timeout: 15_000 });

  // The fabric gets its colours afterwards.
  await page.goto(fabricUrl);
  await page.getByRole("switch", { name: "Aktif" }).click();
  await expect(page.getByRole("switch", { name: "Aktif" })).toHaveAttribute("aria-checked", "true");
  await page.locator("#new-fabric-color-name").fill("Mocca");
  await page.getByRole("button", { name: "Tambah warna", exact: true }).click();
  await expect(page.locator('input[value="Mocca"]')).toBeVisible();

  // Edit: the old line shows as "Tanpa warna (data lama)"; add every colour, delete the old line.
  await page.goto(`${purchaseUrl}/edit`);
  await expect(selectedOption(page, "Warna barang 1")).toHaveText("Tanpa warna (data lama)");
  await expect(page.getByText("Baris lama tanpa warna.")).toBeVisible();
  await page.getByLabel("Harga per yard barang 1").fill("19.500");
  await page.getByRole("button", { name: "Tambah semua warna barang 1" }).click();
  await expect(page.getByTestId("purchase-line")).toHaveCount(3);
  await page.getByRole("button", { name: "Hapus barang 1" }).click();
  await expect(selectedOption(page, "Warna barang 1")).toHaveText("Mocca");
  await expect(selectedOption(page, "Warna barang 2")).toHaveText("Sage");

  // Below what was already paid: refused by the server.
  await page.getByLabel("Jumlah barang 1").fill("5");
  await page.getByLabel("Jumlah barang 2").fill("5");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.locator('form [role="alert"]')).toContainText("tidak boleh lebih kecil dari yang sudah dibayar (Rp 300.000)", { timeout: 15_000 });

  // 30 yard again, split per colour: saved.
  await page.getByLabel("Jumlah barang 1").fill("20");
  await page.getByLabel("Jumlah barang 2").fill("10");
  await expect(page.getByTestId("purchase-form-totals")).toContainText(`${fabricName}30.00 yard · Rp 585.000`);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases$/, { timeout: 15_000 });
  await page.goto(purchaseUrl);
  await expectLines(page, layout, fabricName, ["Mocca", "Sage"]);
}

// ---------- S3: receiving, undo, defects and exchange per colour ----------

const COLOURS = ["Mocca", "Sage", "Tosca"] as const;

/** One "Terima barang" row, found by its colour (every row names the same fabric). */
function receiveLine(page: Page, color: string) {
  return page.getByTestId("receive-line").filter({ has: page.getByTestId("receive-line-color").getByText(color, { exact: true }) });
}

/** On a purchase detail page: "Terima barang", fill each listed colour (others left as prefilled
 * unless given), save, land back on the document. */
async function receiveColours(page: Page, fabricName: string, quantities: Record<string, { good: string; defect?: string }>): Promise<void> {
  const documentUrl = page.url();
  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page).toHaveURL(/\/receive$/);
  for (const [color, { good, defect }] of Object.entries(quantities)) {
    const line = receiveLine(page, color);
    // The "diterima" input is named after the fabric AND the colour.
    await line.getByRole("textbox", { name: `${fabricName}, ${color}` }).fill(good);
    if (defect !== undefined) await line.getByLabel("Ditolak (cacat)").fill(defect);
  }
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page).toHaveURL(documentUrl, { timeout: 15_000 });
}

/** The colour line's quantities in this viewport's layout (the other layout hidden). */
async function expectColourLine(page: Page, layout: Layout, color: string, expected: { diterima: string; cacat: string; ditukar?: string; sisa: string }) {
  const byColor = (selector: string) => page.locator(selector).filter({ has: page.getByTestId("purchase-line-color").getByText(color, { exact: true }) });
  const visible = byColor(layout.lineRow);
  await expect(visible).toHaveCount(1);
  await expect(byColor(layout.hiddenLineRow)).toBeHidden();
  if (layout === MOBILE) {
    await expect(visible).toContainText(`Diterima${expected.diterima}`);
    await expect(visible).toContainText(`Cacat${expected.cacat}`);
    if (expected.ditukar) await expect(visible).toContainText(`Ditukar${expected.ditukar}`);
    await expect(visible).toContainText(`Sisa${expected.sisa}`);
  } else {
    const cells = visible.getByRole("cell");
    await expect(cells.nth(2)).toHaveText(expected.diterima);
    await expect(cells.nth(3)).toHaveText(expected.cacat);
    if (expected.ditukar) await expect(cells.nth(4)).toHaveText(expected.ditukar);
    await expect(cells.nth(6)).toHaveText(expected.sisa);
  }
}

async function createColourPurchase(page: Page, layout: Layout, prefix: string, lines: { color: string; qty: string; amount: string }[]) {
  const marker = `${layout.width}-${Date.now()}`;
  const supplierName = `E2E Pemasok ${prefix} ${marker}`;
  const fabricName = `E2E Marbella ${prefix} ${marker}`;
  await createSupplier(page, supplierName);
  const fabricUrl = await createFabric(page, fabricName, [...COLOURS]);
  await createPurchase(
    page,
    supplierName,
    lines.map((line) => ({ type: "Kain" as const, itemName: fabricName, color: line.color, qty: line.qty, amount: line.amount })),
  );
  return { fabricName, fabricUrl, fabricId: new URL(fabricUrl).pathname.split("/").at(-1)!, purchaseUrl: page.url() };
}

/** Receive a 3-colour PO with a defect on Mocca and Tosca only partly; receive the rest of Tosca;
 * exchange Mocca's defect and receive its replacement into Mocca. */
async function runReceiveColours(page: Page, layout: Layout): Promise<void> {
  const { fabricName, purchaseUrl } = await createColourPurchase(page, layout, "Terima", [
    { color: "Sage", qty: "10", amount: "195.000" },
    { color: "Mocca", qty: "8", amount: "160.000" },
    { color: "Tosca", qty: "5", amount: "97.500" },
  ]);

  // The receive form: one row per colour, swatch + name, prefilled with what is left.
  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page.getByTestId("receive-line-color")).toHaveText([...COLOURS]);
  await expect(receiveLine(page, "Sage").getByRole("textbox", { name: `${fabricName}, Sage` })).toHaveValue("10.00");
  await page.goto(purchaseUrl);
  await receiveColours(page, fabricName, { Sage: { good: "10" }, Mocca: { good: "7", defect: "1" }, Tosca: { good: "3" } });

  await expectColourLine(page, layout, "Sage", { diterima: "10.00 yard", cacat: "0.00 yard", sisa: "0.00 yard" });
  await expectColourLine(page, layout, "Mocca", { diterima: "7.00 yard", cacat: "1.00 yard", sisa: "0.00 yard" });
  await expectColourLine(page, layout, "Tosca", { diterima: "3.00 yard", cacat: "0.00 yard", sisa: "2.00 yard" });
  // Receipt history and the defect history name the colour of every line.
  const receipt = page.getByTestId("receipt-row").first();
  await expect(receipt.getByTestId("receipt-item-color")).toHaveText([...COLOURS]);
  await expect(receipt.getByTestId("receipt-item").filter({ hasText: "Mocca" })).toContainText("7.00 yard · ditolak (cacat) 1.00 yard");
  await expect(page.getByTestId("defect-row").getByTestId("defect-row-color")).toHaveText("Mocca");

  // /stock/defects: the fabric's defect stock, split by colour, in this layout.
  await page.goto("/stock/defects");
  const defectRow = page.locator(layout === MOBILE ? '[data-testid="defect-material-card"]' : '[data-testid="defect-material-row"]').filter({ hasText: fabricName });
  await expect(defectRow.getByTestId("defect-color-chip")).toHaveText(["Mocca1.00 yard"]);

  // Partial receipt: only Tosca is left, prefilled with its 2.00 yard.
  await page.goto(purchaseUrl);
  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page.getByTestId("receive-line")).toHaveCount(1);
  await expect(receiveLine(page, "Tosca").getByRole("textbox", { name: `${fabricName}, Tosca` })).toHaveValue("2.00");
  await page.goto(purchaseUrl);
  await receiveColours(page, fabricName, { Tosca: { good: "2" } });
  await expectColourLine(page, layout, "Tosca", { diterima: "5.00 yard", cacat: "0.00 yard", sisa: "0.00 yard" });

  // Exchange: Mocca's defective yard goes back; the replacement arrives on the Mocca line.
  await page.getByRole("button", { name: `Kembalikan ke supplier: ${fabricName}, Mocca` }).click();
  const dialog = page.getByRole("dialog", { name: `Kembalikan ${fabricName}, Mocca` });
  await dialog.getByLabel("Alasan").fill("Ada noda, tukar");
  await dialog.getByRole("button", { name: "Kembalikan", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Barang cacat dikembalikan ke supplier");
  await expectColourLine(page, layout, "Mocca", { diterima: "7.00 yard", cacat: "0.00 yard", ditukar: "1.00 yard", sisa: "1.00 yard" });
  await expect(page.getByTestId("defect-row").filter({ hasText: "Dikembalikan untuk ditukar" }).getByTestId("defect-row-color")).toHaveText("Mocca");

  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page.getByTestId("receive-line-color")).toHaveText(["Mocca"]);
  await page.goto(purchaseUrl);
  await receiveColours(page, fabricName, { Mocca: { good: "1" } });
  await expectColourLine(page, layout, "Mocca", { diterima: "8.00 yard", cacat: "0.00 yard", ditukar: "1.00 yard", sisa: "0.00 yard" });
  await expect(page.getByText("Diterima lengkap").first()).toBeVisible();
  await expect(page.getByTestId("receipt-row").first().getByTestId("receipt-item-color")).toHaveText(["Mocca"]);
}

/** "Batalkan penerimaan" on one receipt-history row, confirmed; returns the (possibly still open)
 * dialog so a refusal can be asserted. */
async function undoReceipt(page: Page, row: Locator): Promise<Locator> {
  await row.getByRole("button", { name: /Batalkan penerimaan/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Batalkan penerimaan" }).click();
  return dialog;
}

/** Undo is blocked only by a later movement of the SAME colour; here the later movement is another
 * receipt's reversal (a 'purchase_void', which blocks like a consumption). The same rule for a
 * colour adjustment is driven through the UI in runStockPerColour (S4). */
async function runUndoPerColour(page: Page, layout: Layout): Promise<void> {
  const { fabricName } = await createColourPurchase(page, layout, "Batal", [
    { color: "Sage", qty: "10", amount: "195.000" },
    { color: "Mocca", qty: "8", amount: "160.000" },
  ]);
  await receiveColours(page, fabricName, { Sage: { good: "5" }, Mocca: { good: "0" } }); // R1: Sage 5
  await receiveColours(page, fabricName, { Sage: { good: "0" }, Mocca: { good: "8" } }); // R2: Mocca 8
  await receiveColours(page, fabricName, { Sage: { good: "5" } }); // R3: Sage 5
  const rows = page.getByTestId("receipt-row");
  await expect(rows).toHaveCount(3);

  const undo = (row: Locator) => undoReceipt(page, row);

  // R3 (newest, Sage): nothing after it.
  await undo(rows.first());
  await expect(rows).toHaveCount(4, { timeout: 15_000 });
  // R2 (Mocca): R3's Sage reversal came after it, but that is ANOTHER colour, so it is allowed.
  await undo(rows.filter({ has: page.getByTestId("receipt-item-color").getByText("Mocca", { exact: true }) }));
  await expect(rows).toHaveCount(5, { timeout: 15_000 });
  await expectColourLine(page, layout, "Mocca", { diterima: "0.00 yard", cacat: "0.00 yard", sisa: "8.00 yard" });
  // R1 (oldest, Sage): Sage moved after it (R3's reversal), so it is refused.
  const dialog = await undo(rows.last());
  await expect(dialog).toContainText("tidak bisa dibatalkan karena bahannya sudah dipakai atau disesuaikan sesudahnya");
  await dialog.getByRole("button", { name: "Batal", exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expectColourLine(page, layout, "Sage", { diterima: "5.00 yard", cacat: "0.00 yard", sisa: "5.00 yard" });
}

// ---------- S4: stock pages and adjustments per colour ----------

const STOCK_LIST_ROW = { [MOBILE.label]: '[data-testid="fabric-stock-card"]', [DESKTOP.label]: '[data-testid="fabric-stock-row"]' };
const LEDGER_ROW = { [MOBILE.label]: '[data-testid="fabric-ledger-card"]', [DESKTOP.label]: '[data-testid="fabric-ledger-row"]' };
const otherLayout = (layout: Layout) => (layout === MOBILE ? DESKTOP : MOBILE);

/** The per-colour cards (/stock/fabrics/[id], /fabrics/[id]): exactly `expected` [label, qty] in
 * order, plus the total. One responsive grid, so no hidden twin to check. */
async function expectColourCards(page: Page, expected: [string, string][], total: string): Promise<void> {
  const cards = page.getByTestId("fabric-color-balance");
  await expect(cards).toHaveCount(expected.length);
  for (const [index, [label, qty]] of expected.entries()) {
    await expect(cards.nth(index)).toContainText(label);
    await expect(cards.nth(index).getByTestId("fabric-color-balance-qty")).toHaveText(qty);
  }
  await expect(page.getByTestId("fabric-total-balance-qty")).toHaveText(total);
}

/** Ledger rows in this layout (the other layout's twin hidden): each row's colour, newest first. */
async function expectLedgerColours(page: Page, layout: Layout, colours: string[]): Promise<void> {
  const rows = page.locator(LEDGER_ROW[layout.label]!);
  await expect(rows).toHaveCount(colours.length);
  await expect(rows.getByTestId("fabric-ledger-color")).toHaveText(colours);
  await expect(page.locator(LEDGER_ROW[otherLayout(layout).label]!).first()).toBeHidden();
}

/** Receive Sage 10 (R1) then Mocca 8 (R2); the stock pages show each colour; a Sage adjustment
 * (dialog, colour required, bucket can't go negative) blocks undoing R1 but not R2. */
async function runStockPerColour(page: Page, layout: Layout): Promise<void> {
  const { fabricName, fabricUrl, fabricId, purchaseUrl } = await createColourPurchase(page, layout, "Stok", [
    { color: "Sage", qty: "10", amount: "195.000" },
    { color: "Mocca", qty: "8", amount: "240.000" },
  ]);
  await receiveColours(page, fabricName, { Sage: { good: "10" }, Mocca: { good: "0" } }); // R1: Sage 10
  await receiveColours(page, fabricName, { Mocca: { good: "8" } }); // R2: Mocca 8

  // /stock/fabrics/[id]: one card per active colour (Tosca has nothing yet), no Tanpa warna (no
  // colourless history), the total; value and average per colour (owner sees finance).
  const stockUrl = `/stock/fabrics/${fabricId}`;
  await page.goto(stockUrl);
  await expectColourCards(page, [["Mocca", "8.00 yard"], ["Sage", "10.00 yard"], ["Tosca", "0.00 yard"]], "18.00 yard");
  await expect(page.getByTestId("fabric-color-balance").filter({ hasText: "Sage" }).getByTestId("fabric-color-balance-value")).toHaveText(
    "Nilai Rp 195.000 · ≈ Rp 19.500/yard",
  );
  await expect(page.getByTestId("fabric-color-balance").filter({ hasText: "Mocca" }).getByTestId("fabric-color-balance-value")).toHaveText(
    "Nilai Rp 240.000 · ≈ Rp 30.000/yard",
  );
  await expectLedgerColours(page, layout, ["Mocca", "Sage"]);

  // Ledger filter by colour (a link, so it survives a reload).
  const filter = page.getByRole("navigation", { name: "Filter warna" });
  await filter.getByRole("link", { name: "Sage" }).click();
  await expect(page).toHaveURL(/\?warna=[0-9a-f-]+$/);
  await expect(filter.getByRole("link", { name: "Sage" })).toHaveAttribute("aria-current", "page");
  await expectLedgerColours(page, layout, ["Sage"]);

  // "Sesuaikan stok": colour is required, and the chosen colour can't go below zero even though the
  // fabric total (18) could absorb it.
  await page.getByRole("button", { name: "Sesuaikan stok" }).click();
  const dialog = page.getByRole("dialog", { name: "Sesuaikan stok" });
  const colourSelect = dialog.getByRole("combobox", { name: "Warna", exact: true });
  await expect(colourSelect.locator("option:checked")).toHaveText("Pilih warna");
  await expect(colourSelect.locator("option:not([disabled])")).toHaveText([
    "Mocca (stok 8.00 yard)",
    "Sage (stok 10.00 yard)",
    "Tosca (stok 0.00 yard)",
  ]);
  await dialog.getByRole("spinbutton", { name: "Jumlah yard (+/-)" }).fill("-1");
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Pilih warna.");
  await colourSelect.selectOption({ label: "Sage (stok 10.00 yard)" });
  await dialog.getByRole("spinbutton", { name: "Jumlah yard (+/-)" }).fill("-11");
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Stok Sage tidak boleh menjadi negatif (stok sekarang 10.00 yard).");
  await dialog.getByRole("spinbutton", { name: "Jumlah yard (+/-)" }).fill("-1");
  await dialog.getByRole("combobox", { name: "Alasan" }).selectOption({ label: "Rusak/cacat" });
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expectColourCards(page, [["Mocca", "8.00 yard"], ["Sage", "9.00 yard"], ["Tosca", "0.00 yard"]], "17.00 yard");
  // Still filtered to Sage: the adjustment on top, its running balance is Sage's own.
  await expectLedgerColours(page, layout, ["Sage", "Sage"]);
  const newest = page.locator(LEDGER_ROW[layout.label]!).first();
  await expect(newest).toContainText("Penyesuaian · Rusak/cacat");
  await expect(newest).toContainText("9.00 yard");
  await filter.getByRole("link", { name: "Semua warna" }).click();
  await expect(page).toHaveURL(new RegExp(`${stockUrl}$`));
  await expectLedgerColours(page, layout, ["Sage", "Mocca", "Sage"]);

  // /stock/fabrics: per-colour chips in this layout's row.
  await page.goto(`/stock/fabrics?q=${encodeURIComponent(fabricName)}`);
  const listRow = page.locator(STOCK_LIST_ROW[layout.label]!).filter({ hasText: fabricName });
  await expect(listRow.getByTestId("fabric-color-chip-label")).toHaveText(["Mocca", "Sage", "Tosca"]);
  await expect(listRow.getByTestId("fabric-color-chip-qty")).toHaveText(["8.00 yard", "9.00 yard", "0.00 yard"]);
  await expect(page.locator(STOCK_LIST_ROW[otherLayout(layout).label]!).filter({ hasText: fabricName })).toBeHidden();

  // Undo: R2 (Mocca) is allowed, the Sage adjustment is another colour; R1 (Sage) is refused.
  await page.goto(purchaseUrl);
  const rows = page.getByTestId("receipt-row");
  await expect(rows).toHaveCount(2);
  await undoReceipt(page, rows.filter({ has: page.getByTestId("receipt-item-color").getByText("Mocca", { exact: true }) }));
  await expect(rows).toHaveCount(3, { timeout: 15_000 });
  await expectColourLine(page, layout, "Mocca", { diterima: "0.00 yard", cacat: "0.00 yard", sisa: "8.00 yard" });
  const refused = await undoReceipt(page, rows.last());
  await expect(refused).toContainText("tidak bisa dibatalkan karena bahannya sudah dipakai atau disesuaikan sesudahnya");
  await refused.getByRole("button", { name: "Batal", exact: true }).click();
  await expectColourLine(page, layout, "Sage", { diterima: "10.00 yard", cacat: "0.00 yard", sisa: "0.00 yard" });

  // /fabrics/[id]: the same per-colour stock; a deactivated colour with history stays, marked.
  await page.goto(fabricUrl);
  await page.locator("li").filter({ has: page.locator('input[value="Mocca"]') }).getByRole("switch", { name: "Aktif" }).click();
  await expectColourCards(page, [["Mocca", "0.00 yard"], ["Sage", "9.00 yard"], ["Tosca", "0.00 yard"]], "9.00 yard");
  await expect(page.getByTestId("fabric-color-balance").first()).toContainText("(nonaktif)");
  // Tosca (no history) deactivated: gone from the stock cards.
  await page.locator("li").filter({ has: page.locator('input[value="Tosca"]') }).getByRole("switch", { name: "Aktif" }).click();
  await expectColourCards(page, [["Mocca", "0.00 yard"], ["Sage", "9.00 yard"]], "9.00 yard");
}

test.describe("Stok kain per warna", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`stock pages per colour, adjustment per colour, and its effect on undo, at ${layout.label}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await loginAs(page, E2E_FABRIC_COLOUR_EMAIL);
      await runStockPerColour(page, layout);
    });
  }
});

test.describe("Penerimaan kain per warna", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`receive a 3-colour PO with a defect, a partial receipt and an exchange, at ${layout.label}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await loginAs(page, E2E_FABRIC_COLOUR_EMAIL);
      await runReceiveColours(page, layout);
    });

    test(`undo a receipt is blocked only by the same colour, at ${layout.label}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await loginAs(page, E2E_FABRIC_COLOUR_EMAIL);
      await runUndoPerColour(page, layout);
    });
  }
});

test.describe("Pembelian kain per warna", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`create a PO with every colour via "Tambah semua warna", then remove one, at ${layout.label}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await loginAs(page, E2E_FABRIC_COLOUR_EMAIL);
      await runCreateWithColours(page, layout);
    });

    test(`replace a paid colourless line with per-colour lines, at ${layout.label}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await loginAs(page, E2E_FABRIC_COLOUR_EMAIL);
      await runLegacyLineEdit(page, layout);
    });
  }
});

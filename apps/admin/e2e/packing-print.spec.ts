import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_PACKING_PRINT_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";
import { insertToShipOrdersDirectly } from "./helpers/db-order-fixtures";

/** Chromium's `page.pdf()` output isn't object-stream-compressed for its page tree (unlike some
 * PDF producers), so counting `/Type /Page` dictionary markers in the raw bytes — excluding the
 * `/Type /Pages` parent node, hence the `[^s]` — is a reliable, dependency-free way to recover
 * the sheet count without pulling in a full PDF-parsing library just for this one assertion. */
function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

test.describe("printing thank-you cards prints ONLY the cards", () => {
  /** Overrides `window.print()` to notify Node instead of opening a real (unautomatable) print
   * dialog — must be registered via `addInitScript` BEFORE the app's own JS runs, so the
   * override is in place the instant the page (or any later navigation within the same `page`)
   * loads, not patched in afterward once the real button's `onClick` already closed over the
   * native one. */
  async function interceptWindowPrint(page: Page): Promise<() => Promise<void>> {
    let resolvePrinted!: () => void;
    const printed = new Promise<void>((resolve) => {
      resolvePrinted = resolve;
    });
    await page.exposeFunction("__e2ePrintInvoked", () => resolvePrinted());
    await page.addInitScript(() => {
      // @ts-expect-error -- test-only override, not a real print dialog.
      window.print = () => window.__e2ePrintInvoked();
    });
    return () => printed;
  }

  /** `browserName === "webkit"` skips the fabric → product → stock → order UI flow and inserts
   * the two `to_ship` orders directly into `ammari_e2e` instead (helpers/db-order-fixtures.ts) —
   * a pre-existing, unrelated WebKit bug blocks that flow's own form submission (confirmed via a
   * throwaway debug run: clicking "Simpan" on /fabrics/new fires no network request at all under
   * WebKit, no console/page error either). This spec exists to verify the print-timing fix, not
   * that bug, so WebKit gets the same two `to_ship` orders through a UI-independent path instead
   * of being blocked entirely. Chromium keeps the full, realistic UI flow unchanged. */
  async function setUpTwoPrintableOrders(page: Page, browserName: string): Promise<{ orderANo: string; orderBNo: string }> {
    await loginAs(page, E2E_PACKING_PRINT_EMAIL);

    if (browserName === "webkit") {
      const [orderANo, orderBNo] = await insertToShipOrdersDirectly(2);
      await page.goto("/packing");
      await page.locator("tr").filter({ hasText: orderANo! }).getByRole("checkbox").check();
      await page.locator("tr").filter({ hasText: orderBNo! }).getByRole("checkbox").check();
      await page.getByRole("button", { name: /^Cetak kartu/ }).click();
      await expect(page.getByText("2 kartu siap dicetak")).toBeVisible({ timeout: 15_000 });
      return { orderANo: orderANo!, orderBNo: orderBNo! };
    }

    const unique = Date.now();

    const fabricName = `E2E Bahan Print ${unique}`;
    await page.goto("/fabrics/new");
    await page.getByLabel("Nama bahan").fill(fabricName);
    await page.getByLabel("Nama warna").fill("Print");
    await page.getByRole("button", { name: "Simpan" }).click();
    await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

    const productName = `Contoh Gamis Print E2E ${unique}`;
    await page.goto("/products/new");
    await page.getByLabel("Nama produk").fill(productName);
    await page.locator("#product-fabric").selectOption({ label: fabricName });
    await page.getByLabel("Harga dasar").fill("269.000");
    const code = await page.getByLabel("Kode produk").inputValue();
    await page.getByRole("switch", { name: "Aktif" }).click();
    await page.getByRole("button", { name: "Simpan" }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);

    await page.getByRole("checkbox", { name: /Print/ }).check();
    await page.getByRole("checkbox", { name: "M", exact: true }).check();
    await page.getByRole("button", { name: "Tambah varian" }).click();
    const sku = generateSku({ code, closure: "front_zip", color: "Print", size: "M" });
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
    await page.locator(`#qty-${sku}`).fill("2");
    await page.getByRole("button", { name: "Simpan draf" }).click();
    await expect(page).toHaveURL(/\/production\/[0-9a-f-]+$/);
    await page.getByRole("button", { name: "Posting ke stok" }).click();
    await page.getByRole("button", { name: "Posting", exact: true }).click();
    await expect(page.getByRole("button", { name: "Posting ke stok" })).toHaveCount(0, { timeout: 15_000 });

    async function createOrder(): Promise<string> {
      await page.goto("/orders/new");
      await page.locator("#order-channel").selectOption({ label: "WhatsApp" });
      await page.locator(`#qty-${sku}`).fill("1");
      await page.getByRole("button", { name: "Simpan pesanan" }).click();
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/, { timeout: 15_000 });
      return (await page.locator("h1").textContent())!.trim();
    }
    const orderANo = await createOrder();
    const orderBNo = await createOrder();

    await page.goto("/packing");
    await page.locator("tr").filter({ hasText: orderANo }).getByRole("checkbox").check();
    await page.locator("tr").filter({ hasText: orderBNo }).getByRole("checkbox").check();
    await page.getByRole("button", { name: /^Cetak kartu/ }).click();
    await expect(page.getByText("2 kartu siap dicetak")).toBeVisible({ timeout: 15_000 });

    return { orderANo, orderBNo };
  }

  async function shipOrders(page: Page, orderNos: string[]): Promise<void> {
    await page.emulateMedia({ media: "screen" });
    const closeButton = page.getByRole("button", { name: "Tutup" });
    if (await closeButton.isVisible()) await closeButton.click();
    for (const orderNo of orderNos) {
      await page.locator("tr").filter({ hasText: orderNo }).getByRole("checkbox").check();
    }
    await page.getByRole("button", { name: `Tandai dikirim (${orderNos.length})` }).click();
    await expect(page.locator("tr").filter({ hasText: orderNos[0] })).toHaveCount(0, { timeout: 15_000 });
  }

  for (const layoutLabel of ["1 per lembar", "4 per lembar A4"] as const) {
    test(`real "Cetak" button → window.print(): cards are painted and visible under print media (${layoutLabel})`, async ({
      page,
      browserName,
    }) => {
      const waitForPrint = await interceptWindowPrint(page);
      const { orderANo, orderBNo } = await setUpTwoPrintableOrders(page, browserName);
      await page.getByRole("radio", { name: layoutLabel }).check();

      // The REAL flow: click the overlay's own "Cetak" button, which calls `window.print()`
      // (intercepted above) — not an artificial `page.emulateMedia` + `page.pdf()` shortcut
      // taken well after the overlay already settled. This is the exact trigger the real bug
      // report went through.
      await page.getByRole("button", { name: "Cetak", exact: true }).click();
      await waitForPrint();

      // At the EXACT moment `window.print()` fired — not a tick later — switch Playwright's own
      // view to print media and check the cards actually painted, not just mounted. A race
      // between the click and the browser's next paint would show up here as a hidden/empty
      // card even though the DOM node technically exists.
      await page.emulateMedia({ media: "print" });
      const printRoot = page.locator("#print-root");
      await expect(printRoot).toBeVisible();
      await expect(printRoot.getByText(THANK_YOU_GREETING_PATTERN).first()).toBeVisible();
      await expect(printRoot.locator("svg").first()).toBeVisible();
      const qrBox = await printRoot.locator("svg").first().boundingBox();
      expect(qrBox, "QR svg should have a real, painted bounding box, not a collapsed one").not.toBeNull();
      expect(qrBox!.width).toBeGreaterThan(0);
      expect(qrBox!.height).toBeGreaterThan(0);

      // page.pdf() is Chromium-only (Playwright docs) — WebKit still gets the paint-timing
      // assertions above, just not this part.
      if (browserName === "chromium") {
        const pdf = await page.pdf();
        expect(pdf.length, "a PDF with real card content (text + an embedded QR SVG) should be well over a blank page's byte size").toBeGreaterThan(
          8_000,
        );
        expect(countPdfPages(pdf)).toBeGreaterThan(0);
      }

      await shipOrders(page, [orderANo, orderBNo]);
    });
  }
});

const THANK_YOU_GREETING_PATTERN = /^Halo,/;

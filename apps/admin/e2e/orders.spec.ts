import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { purchaseAndReceiveAll } from "./helpers/purchase";
import { postBatchAndReceiveAll } from "./helpers/production";
import { E2E_ORDERS_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";
import { addVariants, createProductDraft } from "./helpers/product";

test("a staffer creates a manual order with its payment, stock decreases, cancels it, then confirms a waiting order's payment", async ({ page }) => {
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
  const { code } = await createProductDraft(page, { name: productName, fabricName, active: false }); // product left inactive; variants are created active either way
  await addVariants(page, /Sage/, ["M"]);
  const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

  // 2. Seed finished-goods stock: purchase 10 yards of fabric for Rp 1.000.000 (avg Rp 100.000/
  // yard), then a production batch producing 5 pcs — HPP/pcs = 1.000.000 / 5 = Rp 200.000 (no
  // accessories/extra costs on this product, so fabric cost is the whole HPP).
  await purchaseAndReceiveAll(page, [{ type: "Kain", itemName: fabricName, qty: "10", amount: "1.000.000" }]);

  await page.goto("/production/new");
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("10");
  await page.getByLabel("M", { exact: true }).fill("5");
  // The live fabric-cost estimate, once the SKU gives the yards a colour (fabric-colour-stock S5).
  await expect(page.getByText("Rp 1.000.000")).toBeVisible();
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await openCreated(page, "/production");

  // Since S4 posting adds no finished-goods stock; receiving the output does.
  await postBatchAndReceiveAll(page);

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
  // D-3 (docs/plans/accounting.md Session 6): an order created already paid needs its payment
  // method, destination account and date. Nothing is preselected, so saving without them is refused.
  await page.getByRole("button", { name: "Simpan pesanan" }).click();
  await expect(page.getByText("Pilih cara bayar.", { exact: true })).toBeVisible();
  // Picking a method preselects its mapped Kas & Bank account: card is a debit card -> Bank utama (D-18).
  await page.locator("#order-payment-method").selectOption("cash");
  await expect(page.locator("#order-payment-account")).toHaveValue("1-1101");
  await page.locator("#order-payment-method").selectOption("card");
  await expect(page.locator("#order-payment-account")).toHaveValue("1-1201");
  await expect(page.locator("#order-payment-paid-on")).not.toHaveValue("");
  await page.getByRole("button", { name: "Simpan pesanan" }).click();
  await openCreated(page, "/orders");
  const orderUrl = page.url();

  // The order page shows the payment record.
  await expect(page.getByTestId("manual-payment-method")).toHaveText("Kartu debit");
  await expect(page.getByTestId("manual-payment-account")).toHaveText("Bank utama");

  // 4. The order detail shows "Siap Kirim" and the snapshotted HPP (Rp 200.000/pcs, from the
  // batch posted above) — this session has finance.view_profit, so cost isn't stripped.
  await expect(page.getByText("Siap Kirim", { exact: true }).first()).toBeVisible();
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

  // 7. Desktop: an order entered as "Menunggu Bayar" asks for no payment; its "Siap Kirim" records
  // the payment and the status change together (D-3).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/orders/new");
  await page.locator("#order-channel").selectOption({ label: "Offline" });
  await page.locator("#order-status").selectOption("awaiting_payment");
  await expect(page.locator("#order-payment-method")).toHaveCount(0);
  await page.locator(`#qty-${sku}`).fill("1");
  await page.getByRole("button", { name: "Simpan pesanan" }).click();
  await openCreated(page, "/orders");
  const payment = page.getByTestId("manual-payment-section");
  await expect(payment.getByText("Cara bayar dicatat saat pesanan ditandai Siap Kirim.")).toBeVisible();

  await page.getByRole("button", { name: "Siap Kirim", exact: true }).click();
  const confirm = page.getByRole("form", { name: "Catat pembayaran" });
  await confirm.locator("#confirm-payment-method").selectOption("cash");
  await expect(confirm.locator("#confirm-payment-account")).toHaveValue("1-1101");
  await confirm.getByRole("button", { name: "Simpan dan tandai Siap Kirim" }).click();
  await expect(page.getByTestId("manual-payment-method")).toHaveText("Tunai", { timeout: 15_000 });
  await expect(page.getByTestId("manual-payment-account")).toHaveText("Kas tunai");
  await expect(page.getByText("Siap Kirim", { exact: true }).first()).toBeVisible();

  // Stock left with the confirmation (5 - 1 = 4).
  await page.goto(`/stock/${sku}`);
  await expect(page.getByText("4 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });
});

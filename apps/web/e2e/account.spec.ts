import { randomInt } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { customerNameOf, issueLoginLink, seedLinkCustomer, setCustomerName, type LinkCustomer } from "./helpers/login-link-db";

// /account (2026-10-21 sandbox run): the buyer sees and edits their name, and a page left open
// across a deploy answers "Halaman sudah diperbarui. Coba lagi." instead of a blank page. Runs with
// the cart flag off and on (the account page works either way).

async function ownIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.17.${randomInt(0, 255)}.${randomInt(1, 254)}` });
}

async function login(page: Page, customer: LinkCustomer): Promise<void> {
  const token = await issueLoginLink(customer);
  await page.goto(`/login/link?token=${token}`);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
}

test("the placeholder name can be replaced on /account", async ({ page, context }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("nama-akun");
  await setCustomerName(customer.id, "Pelanggan Ammari");
  await login(page, customer);
  await page.goto("/account");

  await expect(page.getByTestId("account-name")).toHaveText("Pelanggan Ammari");
  await page.getByRole("button", { name: "Isi nama" }).click();
  const input = page.getByLabel("Nama", { exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "Simpan" }).click();
  // Required in the browser; a blank name never reaches the server.
  await expect(input).toBeVisible();
  await input.fill("  Siti   Aminah ");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByTestId("account-name")).toHaveText("Siti Aminah");
  await expect(page.getByRole("button", { name: "Ubah nama" })).toBeFocused();
  expect(await customerNameOf(customer.id)).toBe("Siti Aminah");
  await page.reload();
  await expect(page.getByTestId("account-name")).toHaveText("Siti Aminah");
});

test("a page from the previous build: its server action is unknown, the buyer gets a message and a reload, never a blank page", async ({ page, context }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("versi-lama");
  await login(page, customer);
  await page.goto("/account");
  await page.getByRole("button", { name: "Ubah nama" }).click();
  await page.getByLabel("Nama", { exact: true }).fill("Nama Baru");

  // What the new server answers to an action id it does not know (Next's own "not found" reply).
  await page.route("**/account", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      await route.fulfill({ status: 404, headers: { "x-nextjs-action-not-found": "1", "content-type": "text/plain" }, body: "Server action not found." });
      return;
    }
    await route.continue();
  });
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByTestId("stale-page-notice")).toHaveText("Halaman sudah diperbarui. Coba lagi.");
  await reloaded;
  await page.unroute("**/account");
  await expect(page.getByTestId("account-name")).toBeVisible();
  expect(await customerNameOf(customer.id)).toBe("Pembeli Link E2E");
});

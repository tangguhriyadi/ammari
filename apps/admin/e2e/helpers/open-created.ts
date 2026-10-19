import { expect, type Page } from "@playwright/test";

const UUID = "[0-9a-f-]{36}";

/**
 * After a successful create, most forms redirect to the entity's LIST page (not its detail page)
 * and raise a toast (products and fabrics are the exception: they land on the new detail page,
 * so they don't need this). Specs that keep working on the new record use this to reach its
 * detail page the way a person does: wait for the redirect, then click the record's row link.
 *
 * `search` narrows the list through its `?q=` box (fabrics, products, accessories, purchases,
 * orders); lists without a search box (production batches) are newest-first, so the first row is
 * the record that was just created.
 */
export async function openCreated(page: Page, listPath: string, search?: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^http://[^/]+${listPath}$`), { timeout: 15_000 });
  if (search) await page.goto(`${listPath}?q=${encodeURIComponent(search)}`);

  // `:visible` — both the phone card list and the desktop table render a link per row, and only
  // the layout for the current viewport is displayed.
  const hrefs = await page
    .locator(`main a[href^="${listPath}/"]:visible`)
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
  const href = hrefs.find((candidate) => new RegExp(`^${listPath}/${UUID}$`).test(candidate));
  expect(href, `a detail link under ${listPath}`).toBeTruthy();
  await page.locator(`main a[href="${href}"]:visible`).first().click();
  await expect(page).toHaveURL(new RegExp(`^http://[^/]+${listPath}/${UUID}$`));
}

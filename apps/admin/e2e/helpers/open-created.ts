import { expect, type Page } from "@playwright/test";

const UUID = "[0-9a-f-]{36}";

/** "ORD-202611-": the prefix generateOrderNumber gives an order created now (Asia/Jakarta month,
 * a fixed UTC+7 offset). */
function currentOrderNoPrefix(): string {
  const jakarta = new Date(Date.now() + 7 * 60 * 60_000);
  return `ORD-${jakarta.toISOString().slice(0, 4)}${jakarta.toISOString().slice(5, 7)}-`;
}

/**
 * After a successful create, most forms redirect to the entity's LIST page (not its detail page)
 * and raise a toast (products and fabrics are the exception: they land on the new detail page,
 * so they don't need this). Specs that keep working on the new record use this to reach its
 * detail page the way a person does: wait for the redirect, then click the record's row link.
 *
 * `search` narrows the list through its `?q=` box (fabrics, products, accessories, purchases,
 * orders). Production batches have no search box: a batch just saved is always a draft dated today
 * with the month's highest number, so the list's own "Draf" filter (`?status=draft`, newest produced
 * first, then highest number) puts it first. Not the unfiltered list: global-setup seeds posted
 * batches (the accounting trial month, December 2026) dated after today, and those sort above it.
 */
export async function openCreated(page: Page, listPath: string, search?: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^http://[^/]+${listPath}$`), { timeout: 15_000 });
  if (search) await page.goto(`${listPath}?q=${encodeURIComponent(search)}`);
  else if (listPath === "/production") await page.goto(`${listPath}?status=draft`);
  // An order saved through the app is numbered ORD-<Jakarta yyyymm>-NNNN; seeded orders are named
  // ORD-E2E-*, and one of them (the accounting trial-month sale) is created after today, so it would
  // sort above the new order in the unfiltered newest-first list.
  else if (listPath === "/orders") await page.goto(`${listPath}?q=${encodeURIComponent(currentOrderNoPrefix())}`);

  // The list streams in behind its route skeleton (loading.tsx); the read below is one-shot, so
  // wait until the skeleton has been replaced by the real list first.
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
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

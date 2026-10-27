import { expect, test as base, type Locator, type Page } from "@playwright/test";

/** Waits until a document load has settled into the real, hydrated page: the route's loading.tsx
 * skeleton (any `aria-busy` region) has been replaced, and React has hydrated the page content
 * (React tags every hydrated DOM node with a `__reactFiber$...` key). Pages outside the shell
 * (no `<main>`, e.g. /login) only wait for the skeleton check.
 *
 * Why it is needed (docs/plans/admin-performance.md): with a loading boundary, a full document
 * load streams the skeleton first and the page content after it; React reveals and hydrates that
 * content a moment after the `load` event `page.goto` waits for. A spec that fills a form right
 * after `goto` could otherwise type into inputs React has not hydrated yet, and lose the input.
 * Deliberately not `waitForLoadState("networkidle")`: once reached, Playwright resolves later
 * `networkidle` waits immediately, which would break the specs that use one to wait for a save. */
export async function waitForPageReady(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const content = document.querySelector("main > div")?.firstElementChild;
      if (!document.querySelector("main")) return true;
      return !!content && Object.keys(content).some((key) => key.startsWith("__reactFiber$"));
    },
    undefined,
    { timeout: 15_000 },
  );
}

/** `@playwright/test`'s `test`, with `page.goto` and `page.reload` waiting for `waitForPageReady`. */
export const test = base.extend({
  page: async ({ page }, provide) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const response = await goto(...args);
      await waitForPageReady(page);
      return response;
    };
    page.reload = async (...args: Parameters<Page["reload"]>) => {
      const response = await reload(...args);
      await waitForPageReady(page);
      return response;
    };
    await provide(page);
  },
});

export { expect };

/** Resolves with the response of the next Server Action call (a save, publish, discard or upload).
 * Create it BEFORE the click/file pick that triggers the action. */
export function nextActionResponse(page: Page) {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && Boolean(response.request().headers()["next-action"]),
    { timeout: 15_000 },
  );
}

/** Clicks a button that runs a Server Action and waits for that action's own response, so the next
 * step (often a `goto` to check the saved data) cannot abort it. Precise where
 * `waitForLoadState("networkidle")` is not: that resolves at once when the page already went idle
 * earlier. */
export async function clickAndWaitForAction(page: Page, button: Locator): Promise<void> {
  const actionDone = nextActionResponse(page);
  await button.click();
  await actionDone;
}

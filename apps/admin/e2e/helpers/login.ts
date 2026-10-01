import type { Page } from "@playwright/test";

/** Signs `page`'s browsing context in via the e2e-only backdoor (app/api/test/login/route.ts),
 * which runs the real Better Auth sign-in code path end to end. `page.request` shares the page's
 * context's cookie jar, so the resulting session cookie is already set before `page.goto`. */
export async function loginAs(page: Page, email: string): Promise<void> {
  const response = await page.request.post("/api/test/login", { data: { email } });
  if (!response.ok()) {
    throw new Error(`e2e login failed for ${email}: ${response.status()} ${await response.text()}`);
  }
}

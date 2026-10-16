import type { Page } from "@playwright/test";

/** Reads back the OTP a REAL `/login` form submission just sent for `email`, via the e2e-only
 * `/api/test/otp` backdoor (app/api/test/otp/route.ts) — same helper as
 * apps/admin/e2e/helpers/otp.ts, for the main site's own login form. */
export async function takeOtp(page: Page, email: string): Promise<string> {
  const response = await page.request.post("/api/test/otp", { data: { email } });
  if (!response.ok()) {
    throw new Error(`e2e OTP read failed for ${email}: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { otp: string };
  return body.otp;
}

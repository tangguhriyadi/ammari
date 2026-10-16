import { expect, test } from "@playwright/test";
import { takeOtp } from "./helpers/otp";

// Web allows self sign-up for ANY email (no staff-style fixture seeding needed, unlike
// apps/admin's equivalent spec) — each test below mints its own unique @e2e.ammari.test
// addresses (per browser project, via testInfo) so a chromium and a webkit run of the "same"
// test never land inside each other's 60s per-email resend cooldown.
function uniqueEmail(testInfo: { project: { name: string } }, label: string): string {
  return `${label}-${testInfo.project.name}-${Date.now()}@e2e.ammari.test`;
}

test("wrong email -> Ganti email -> correct email signs in", async ({ page }, testInfo) => {
  await page.goto("/login");

  const wrongEmail = uniqueEmail(testInfo, "wrong");
  await page.getByLabel("Email").fill(wrongEmail);
  await page.getByRole("button", { name: "Kirim kode" }).click();

  // Web has no account-existence distinction to protect (self sign-up means every email is
  // eligible), but the step still advances identically regardless.
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();
  await expect(page.getByText(wrongEmail, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Ganti email" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toHaveCount(0);
  await expect(page.getByLabel("Email")).toHaveValue(wrongEmail);

  const correctEmail = uniqueEmail(testInfo, "correct");
  await page.getByLabel("Email").fill(correctEmail);
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();

  const otp = await takeOtp(page, correctEmail);
  await page.getByLabel("Kode (6 digit)").fill(otp);
  await page.getByRole("button", { name: "Masuk" }).click();

  // Default `next` is /account, which a brand-new self-signup customer (no pdp_consent_at yet)
  // is redirected away from — landing on /consent is the real signal that sign-in succeeded.
  await expect(page).toHaveURL(/\/consent(\?|$)/);
});

test("resend stays disabled with a countdown for 60s, then becomes available (fake clock)", async ({ page }, testInfo) => {
  // Only the BROWSER's clock moves (see apps/admin's identical spec for the full reasoning) —
  // the Node dev server's own real clock, and therefore the real 60s cooldown, is untouched.
  await page.clock.install();
  await page.goto("/login");

  await page.getByLabel("Email").fill(uniqueEmail(testInfo, "resend"));
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();

  // +2s buffer: `Date.now()` is read here in the TEST process, but `pauseAt` targets the PAGE's
  // own (still real-time-ticking) clock — by the time that command reaches the browser, its
  // clock may have already ticked past an un-buffered "now", and pauseAt refuses to rewind
  // ("Cannot fast-forward to the past"). This also means some small, variable amount of real
  // time (page load, the send round-trip, this buffer) has already elapsed by the time the
  // clock is actually paused — so the two checks below are deliberately NOT split exactly at
  // 59s/60s from this point (that would assume the 60s budget started exactly here, which it
  // didn't). 30s comfortably stays under whatever's realistically still remaining; the second
  // jump brings the cumulative total comfortably past 60s regardless of that same drift.
  await page.clock.pauseAt(Date.now() + 2_000);

  const resendButton = page.getByRole("button", { name: /Kirim ulang/ });
  await expect(resendButton).toHaveText(/Kirim ulang dalam/);
  await expect(resendButton).toBeDisabled();

  await page.clock.fastForward(30_000);
  await expect(resendButton).toBeDisabled();

  await page.clock.fastForward(35_000);
  await expect(resendButton).toHaveText("Kirim ulang kode");
  await expect(resendButton).toBeEnabled();
});

test("an expired code is rejected", async ({ page }, testInfo) => {
  // E2E_OTP_EXPIRES_IN_SECONDS=8 (playwright.config.ts's webServer.env) shortens the SERVER's
  // real expiry only — see apps/admin's identical spec for why the client's own countdown
  // deliberately isn't asserted on here (it still counts down from the real 300s constant).
  await page.goto("/login");
  const email = uniqueEmail(testInfo, "expiry");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();

  const otp = await takeOtp(page, email);
  await page.waitForTimeout(9_000); // past the real, shortened 8s server-side expiry

  await page.getByLabel("Kode (6 digit)").fill(otp);
  await page.getByRole("button", { name: "Masuk" }).click();

  await expect(page.getByText("Kode tidak valid. Coba lagi.")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

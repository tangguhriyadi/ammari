import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  E2E_LOGIN_OTP_EMAIL,
  E2E_LOGIN_OTP_EXPIRY_EMAIL,
  E2E_LOGIN_OTP_MOBILE_EMAIL,
  E2E_LOGIN_OTP_RESEND_EMAIL,
} from "./global-setup";
import { takeOtp } from "./helpers/otp";

async function runWrongEmailThenChangeFlow(page: Page, correctEmail: string): Promise<void> {
  await page.goto("/login");

  const wrongEmail = `wrong-${Date.now()}@e2e.ammari.test`;
  await page.getByLabel("Email").fill(wrongEmail);
  await page.getByRole("button", { name: "Kirim kode" }).click();

  // Anti-enumeration: an email with no matching active staff member still advances to the OTP
  // step, identically to a real one.
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();
  await expect(page.getByText(wrongEmail, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Ganti email" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toHaveCount(0); // back to the email step
  await expect(page.getByLabel("Email")).toHaveValue(wrongEmail); // prefilled, not blank

  await page.getByLabel("Email").fill(correctEmail);
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();

  const otp = await takeOtp(page, correctEmail);
  await page.getByLabel("Kode (6 digit)").fill(otp);
  await page.getByRole("button", { name: "Masuk" }).click();

  await expect(page).toHaveURL("/");
}

test("wrong email -> Ganti email -> correct email signs in (desktop, 1280px)", async ({ page }) => {
  await runWrongEmailThenChangeFlow(page, E2E_LOGIN_OTP_EMAIL);
});

test("wrong email -> Ganti email -> correct email signs in (mobile, 390px)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await runWrongEmailThenChangeFlow(page, E2E_LOGIN_OTP_MOBILE_EMAIL);
});

test("resend stays disabled with a countdown for 60s, then becomes available (fake clock)", async ({ page }) => {
  // Installs BEFORE navigating so every timer the page creates from its very first script
  // execution onward is already clock-controlled — only the BROWSER's clock moves; the Node dev
  // server's own real clock is untouched, so this never claims the server's actual 60s cooldown
  // has elapsed (see this spec file's own header comment on why that's a separate, server-side
  // guarantee covered in packages/auth's own tests instead).
  await page.clock.install();
  await page.goto("/login");

  await page.getByLabel("Email").fill(E2E_LOGIN_OTP_RESEND_EMAIL);
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();

  // A merely-installed clock still advances in real time until paused (Playwright's own Clock
  // docs), and `Date.now()` here is read in the TEST process, not the page — by the time
  // `pauseAt` reaches the browser, its clock may already be past an un-buffered "now" (pauseAt
  // then refuses to rewind: "Cannot fast-forward to the past"), so the actual pause point is
  // some small, variable amount of real time after the send above (page load, the send
  // round-trip, this +2s buffer). The two checks below are deliberately NOT split exactly at
  // 59s/60s from here for that reason — 30s comfortably stays under whatever's realistically
  // still remaining of the 60s budget; the second jump brings the cumulative total comfortably
  // past it regardless of that same drift.
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

test("an expired code is rejected", async ({ page }) => {
  // E2E_OTP_EXPIRES_IN_SECONDS=8 (playwright.config.ts's webServer.env) shortens the SERVER's
  // real expiry only — the client still counts down from the real 300s constant
  // (@ammari/auth/otp-timing), since the client has no way to know the server's expiry was
  // overridden for this one e2e run (nor should it: that's test-only server config, not
  // something to thread through to the client bundle just for this). So the UI's own "Kode
  // sudah kedaluwarsa" state deliberately never shows here — that path is already covered with
  // the real 5-minute constant in login-form.test.tsx. This test instead waits past the real
  // (shortened) server-side expiry and confirms the SERVER actually rejects the code — the
  // property that actually matters.
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_LOGIN_OTP_EXPIRY_EMAIL);
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();

  const otp = await takeOtp(page, E2E_LOGIN_OTP_EXPIRY_EMAIL);
  await page.waitForTimeout(9_000); // past the real, shortened 8s server-side expiry

  await page.getByLabel("Kode (6 digit)").fill(otp);
  await page.getByRole("button", { name: "Masuk" }).click();

  await expect(page.getByText("Kode tidak valid atau akun tidak ditemukan.")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

for (const [label, viewport] of [
  ["desktop, 1280px", null],
  ["mobile, 390px", { width: 390, height: 844 }],
] as const) {
  test(`/login?email= prefills the field and focuses Kirim kode without sending a code (${label})`, async ({ page }) => {
    if (viewport) await page.setViewportSize(viewport);
    await page.goto(`/login?email=${encodeURIComponent("Invitee+1@e2e.ammari.test")}`);
    await expect(page.getByLabel("Email")).toHaveValue("invitee+1@e2e.ammari.test");
    await expect(page.getByRole("button", { name: "Kirim kode" })).toBeFocused();
    await expect(page.getByLabel("Kode (6 digit)")).toHaveCount(0);

    await page.goto("/login?email=not-an-email");
    await expect(page.getByLabel("Email")).toHaveValue("");
  });
}

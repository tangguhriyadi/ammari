import "server-only";
import { after } from "next/server";
import { nextCookies } from "better-auth/next-js";
import { createCustomerAuth } from "@ammari/auth/customer";
import { ConsoleEmailSender, ResendEmailSender, UnconfiguredEmailSender } from "@ammari/auth";
import { CapturingEmailSender } from "@ammari/auth/testing";
import { db } from "@ammari/db";
import { emailLogoUrl } from "@ammari/email";
import { LOGIN_LINK_PAGE_PATH, LOGIN_LINK_SUCCESS_PATH } from "./login-link-paths";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Only ever selected when BOTH conditions hold — see app/api/test/otp/route.ts, which is the
// one and only reader of `capturingEmailSender`. Same posture as apps/admin's identically-named
// constant: NODE_ENV can't be "production" in an actual production build/start, so this is
// never reachable there regardless of E2E_TEST_LOGIN.
const isE2eTestLoginEnabled = process.env.NODE_ENV !== "production" && process.env.E2E_TEST_LOGIN === "true";

export const capturingEmailSender = isE2eTestLoginEnabled ? new CapturingEmailSender() : null;

function emailSender() {
  if (capturingEmailSender) return capturingEmailSender;
  // Resend (see @ammari/auth's ResendEmailSender) when configured — shared with apps/admin's
  // own staff instance, same two env vars. Falls back to console locally / throws in
  // production without it, same posture as the staff instance (never silently drop an OTP).
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (apiKey && from) return new ResendEmailSender({ apiKey, from });
  return process.env.NODE_ENV === "production" ? new UnconfiguredEmailSender() : new ConsoleEmailSender();
}

function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

export const isGoogleConfigured = Boolean(googleConfig());

const baseURL = requiredEnv("BETTER_AUTH_URL");
const secret = process.env.CUSTOMER_BETTER_AUTH_SECRET ?? "";
const google = googleConfig();

// Optional — createCustomerAuth falls back to DEFAULT_OTP_GLOBAL_HOURLY_CAP when unset. See
// apps/admin's own staff.ts for the full reasoning (shared circuit breaker).
const rawGlobalHourlyCap = process.env.OTP_GLOBAL_HOURLY_CAP;
const globalHourlyCap = rawGlobalHourlyCap ? Number(rawGlobalHourlyCap) : undefined;

// Gated behind isE2eTestLoginEnabled, not just "is this env var set" — see apps/admin's own
// staff.ts for why. The one and only reason this exists: e2e/login-otp.spec.ts's "expired code
// rejected" test.
const expiresInSecondsOverride =
  isE2eTestLoginEnabled && process.env.E2E_OTP_EXPIRES_IN_SECONDS
    ? Number(process.env.E2E_OTP_EXPIRES_IN_SECONDS)
    : undefined;

export const customerAuth = createCustomerAuth({
  db,
  emailSender: emailSender(),
  baseURL,
  secret,
  google,
  globalHourlyCap,
  expiresInSecondsOverride,
  extraPlugins: [nextCookies()],
  orderLoginLink: { successPath: LOGIN_LINK_SUCCESS_PATH, pagePath: LOGIN_LINK_PAGE_PATH },
  // This instance's own origin is the storefront, which serves the logo (null locally over http).
  emailLogoUrl: emailLogoUrl(baseURL),
  // Runs sendVerificationOTP's email delivery after the HTTP response is already sent, so the
  // caller isn't stuck waiting on the email provider's own round-trip — unlike the staff
  // instance, there's no enumeration/timing-side-channel reason here (self sign-up means
  // "known vs unknown email" isn't a distinction that matters), just plain responsiveness.
  //
  // NOTE: this does NOT affect whether a send failure is visible anywhere — confirmed by
  // reading better-auth's own dist/context/create-context.mjs `runInBackgroundOrAwait`: with OR
  // without this handler, a rejected sendVerificationOTP promise is caught and logged (never
  // rethrown) by better-auth itself, and dist/plugins/email-otp/routes.mjs's own endpoint
  // unconditionally returns `{ success: true }` either way. That's a structural property of
  // better-auth's emailOTP plugin, not something this handler controls — see the explicit log
  // statement inside this instance's own sendVerificationOTP callback (create-customer-auth.ts)
  // for the most this layer can do about it.
  //
  // Skipped in e2e mode (same reasoning as apps/admin's own staffAuth): app/api/test/otp/
  // route.ts reads the captured OTP right after driving the REAL `/login` form, and an
  // after()-deferred send wouldn't have run yet at that point.
  ...(isE2eTestLoginEnabled ? {} : { backgroundTaskHandler: (promise: Promise<unknown>) => after(() => promise) }),
  ...(isE2eTestLoginEnabled && capturingEmailSender
    ? { onOtpGenerated: (params: { email: string; otp: string }) => capturingEmailSender.capture(params) }
    : {}),
});

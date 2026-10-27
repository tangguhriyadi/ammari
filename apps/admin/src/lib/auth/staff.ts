import "server-only";
import { after } from "next/server";
import { nextCookies } from "better-auth/next-js";
import { createStaffAuth } from "@ammari/auth/staff";
import { ConsoleEmailSender, ResendEmailSender, UnconfiguredEmailSender } from "@ammari/auth";
import { CapturingEmailSender } from "@ammari/auth/testing";
import { db } from "@ammari/db";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Only ever selected when BOTH conditions hold — see app/api/test/login/route.ts, which is the
// one and only reader of `capturingEmailSender`. NODE_ENV can't be "production" in an actual
// production build/start, so this is never reachable there regardless of E2E_TEST_LOGIN.
const isE2eTestLoginEnabled = process.env.NODE_ENV !== "production" && process.env.E2E_TEST_LOGIN === "true";

export const capturingEmailSender = isE2eTestLoginEnabled ? new CapturingEmailSender() : null;

function emailSender() {
  if (capturingEmailSender) return capturingEmailSender;
  // Resend (see @ammari/auth's ResendEmailSender) when configured — shared with apps/web's own
  // customer instance, same two env vars. Falls back to console locally / throws in production
  // without it (docs/SPEC.md's Pre-deploy checklist: production must fail loudly rather than
  // silently drop OTP emails).
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

/** The same sender the OTP emails use (Resend when configured, console locally, the no-op
 * capturing sender in e2e), shared with the staff invite email (lib/staff/mutations.ts). */
export const staffEmailSender = emailSender();
/** The admin app's own origin, for links in emails (the invite tells people where to log in). */
export const adminBaseUrl = baseURL;
const secret = process.env.STAFF_BETTER_AUTH_SECRET ?? "";
const google = googleConfig();

// Optional — createStaffAuth falls back to DEFAULT_OTP_GLOBAL_HOURLY_CAP when unset. Lets the
// whole-system OTP circuit breaker be tuned per environment without a code change once real
// send volume is known.
const rawGlobalHourlyCap = process.env.OTP_GLOBAL_HOURLY_CAP;
const globalHourlyCap = rawGlobalHourlyCap ? Number(rawGlobalHourlyCap) : undefined;

// Gated behind isE2eTestLoginEnabled (not just "is this env var set"), so this can't shrink the
// real 5-minute expiry even if E2E_OTP_EXPIRES_IN_SECONDS were somehow set outside an actual e2e
// run — see e2e/login-otp.spec.ts's "expired code rejected" test, the one and only reason this
// exists.
const expiresInSecondsOverride =
  isE2eTestLoginEnabled && process.env.E2E_OTP_EXPIRES_IN_SECONDS
    ? Number(process.env.E2E_OTP_EXPIRES_IN_SECONDS)
    : undefined;

export const staffAuth = createStaffAuth({
  db,
  emailSender: staffEmailSender,
  baseURL,
  secret,
  google,
  globalHourlyCap,
  expiresInSecondsOverride,
  extraPlugins: [nextCookies()],
  // Runs sendVerificationOTP's whole body (throttle check + staff lookup + email send) after the
  // HTTP response is already sent, so an unknown/inactive/throttled email and a real one take
  // the same (near-zero) time from the caller's perspective — closes the timing side-channel a
  // synchronously-awaited email send would otherwise open. Next's after() works in Route
  // Handlers on a self-hosted Node server, not just serverless platforms.
  //
  // Skipped in e2e mode (see isE2eTestLoginEnabled): app/api/test/otp/route.ts reads the
  // captured OTP right after driving the REAL `/login` form, in the same spirit as
  // e2eSignInAuth's own comment below — an after()-deferred send wouldn't have run yet at that
  // point. Only reachable at all when E2E_TEST_LOGIN is explicitly "true" and NODE_ENV isn't
  // "production", same four-gate posture as the rest of this test-only surface.
  ...(isE2eTestLoginEnabled ? {} : { backgroundTaskHandler: (promise: Promise<unknown>) => after(() => promise) }),
  ...(isE2eTestLoginEnabled && capturingEmailSender
    ? { onOtpGenerated: (params: { email: string; otp: string }) => capturingEmailSender.capture(params) }
    : {}),
});

/** e2e-only (see app/api/test/login/route.ts, the one and only caller). Same db/baseURL/secret/
 * google as `staffAuth` above — so a session it creates is valid for every other request, which
 * is handled by the ordinary `staffAuth` instance — but WITHOUT `backgroundTaskHandler`: that
 * route calls sendVerificationOTP then immediately reads the captured OTP within the same
 * request, and an `after()`-deferred send would not have run yet at that point (after() tasks
 * only run once this request's own response has already been sent). Skipping the deferral here
 * also skips the timing-side-channel protection it exists for, which is fine: this instance is
 * only ever reached through the quadruple-gated test backdoor, never by a real sign-in attempt.
 * `disableSendThrottle: true` for the same reason: this route can legitimately resend for the
 * SAME e2e fixture email well within the real 60s cooldown (a WebKit retry, or several specs
 * sharing a role's fixture back to back), which the real cooldown would otherwise silently
 * suppress — that's the real behavior login-otp.spec.ts tests against the ORDINARY `staffAuth`
 * instance below, not this one. */
export const e2eSignInAuth =
  isE2eTestLoginEnabled && capturingEmailSender
    ? createStaffAuth({
        db,
        emailSender: capturingEmailSender,
        baseURL,
        secret,
        google,
        extraPlugins: [nextCookies()],
        onOtpGenerated: (params) => capturingEmailSender.capture(params),
        disableSendThrottle: true,
      })
    : null;

import "server-only";
import { after } from "next/server";
import { nextCookies } from "better-auth/next-js";
import { createStaffAuth } from "@ammari/auth/staff";
import { ConsoleEmailSender, UnconfiguredEmailSender } from "@ammari/auth";
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
  // No real provider chosen yet (see docs/SPEC.md's Pre-deploy checklist) — production must
  // fail loudly rather than silently drop OTP emails.
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
const secret = process.env.STAFF_BETTER_AUTH_SECRET ?? "";
const google = googleConfig();

export const staffAuth = createStaffAuth({
  db,
  emailSender: emailSender(),
  baseURL,
  secret,
  google,
  extraPlugins: [nextCookies()],
  // Runs sendVerificationOTP's whole body (throttle check + staff lookup + email send) after the
  // HTTP response is already sent, so an unknown/inactive/throttled email and a real one take
  // the same (near-zero) time from the caller's perspective — closes the timing side-channel a
  // synchronously-awaited email send would otherwise open. Next's after() works in Route
  // Handlers on a self-hosted Node server, not just serverless platforms.
  backgroundTaskHandler: (promise) => after(() => promise),
});

/** e2e-only (see app/api/test/login/route.ts, the one and only caller). Same db/baseURL/secret/
 * google as `staffAuth` above — so a session it creates is valid for every other request, which
 * is handled by the ordinary `staffAuth` instance — but WITHOUT `backgroundTaskHandler`: that
 * route calls sendVerificationOTP then immediately reads the captured OTP within the same
 * request, and an `after()`-deferred send would not have run yet at that point (after() tasks
 * only run once this request's own response has already been sent). Skipping the deferral here
 * also skips the timing-side-channel protection it exists for, which is fine: this instance is
 * only ever reached through the quadruple-gated test backdoor, never by a real sign-in attempt. */
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
      })
    : null;

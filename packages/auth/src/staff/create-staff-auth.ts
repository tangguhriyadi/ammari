import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { GoogleOptions } from "better-auth/social-providers";
import * as schema from "@ammari/db/schema";
import type { EmailSender } from "../email-sender";
import {
  type Database,
  isActiveStaffAuthUser,
  loadActiveStaffForEmail,
  markStaffLastLogin,
} from "./staff-data";
import { recordEmailThrottleAttempt } from "../shared/email-throttle";
import { OTP_EXPIRES_IN_SECONDS, OTP_RESEND_COOLDOWN_SECONDS } from "../shared/otp-timing";
import { signInCodeMessage } from "../shared/sign-in-code-email";

// 6 digits / 5 attempts: CLAUDE.md's OTP rules. Expiry itself comes from shared/otp-timing.ts —
// the ONE place the server config and the client countdown UI both read "5 minutes" from.
const OTP_MAX_ATTEMPTS = 5;
// Per-email send cap (see schema/auth-throttle.ts) — intentionally the same window as OTP
// expiry, so "5 codes alive at once" and "5 sends per window" line up. The 60s-apart minimum
// (OTP_RESEND_COOLDOWN_SECONDS) fits inside it with room to spare: 5 sends 60s apart span 240s,
// still under this 300s window.
const OTP_SEND_WINDOW_SECONDS = 5 * 60;
const OTP_SEND_MAX_PER_WINDOW = 5;
// Whole-system circuit breaker (shared across the staff AND customer instances — same
// `auth_email_throttle` table): protects the Resend sending quota and mail.ammari.id's sender
// reputation from ever being exhausted by a bug or an abuse pattern that gets past the
// per-email/per-IP limits below. Configurable (apps/admin passes OTP_GLOBAL_HOURLY_CAP) because
// the right number depends on real send volume once this is live; 300/hour is a deliberately
// generous starting default — comfortably above any realistic legitimate login volume this
// business sees today, while still being a real backstop against a runaway sender.
const OTP_GLOBAL_WINDOW_SECONDS = 60 * 60;
export const DEFAULT_OTP_GLOBAL_HOURLY_CAP = 300;
// Better Auth's own per-IP limiter on the send endpoint — generous on purpose. Indonesian mobile
// carriers use CGNAT: thousands of real customers/staff can share one public IP, so anything
// close to "1 per minute per IP" (which would otherwise be the natural per-IP mirror of the
// per-email cooldown below) risks blocking legitimate users at launch. This is sized as abuse
// protection against "hit send for many different emails from one IP," not as the resend
// cooldown itself — that's enforced per-email instead (see OTP_RESEND_COOLDOWN_SECONDS below).
const OTP_IP_ABUSE_WINDOW_SECONDS = 10 * 60;
const OTP_IP_ABUSE_MAX = 20;
// Verify (code-guessing) attempts — a separate mechanism from the send-side limits above.
const VERIFY_RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const VERIFY_RATE_LIMIT_MAX = 10;

const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24; // 1 day

// Test-only escape hatches: both are real better-auth `GoogleOptions`/`ProviderOptions` fields,
// used in tests to stub Google's token-exchange/profile-fetch boundary (see packages/auth/test).
// Never set in production — leaving them unset uses better-auth's real Google OAuth
// implementation.
export type GoogleProviderOverrides = Pick<GoogleOptions, "getUserInfo" | "verifyIdToken">;

export interface CreateStaffAuthOptions {
  db: Database;
  emailSender: EmailSender;
  /** The admin app's own origin, e.g. "https://admin.ammari.id" or "http://localhost:3001". Used
   * as both `baseURL` and the sole entry of `trustedOrigins` — never derived from a request
   * header. */
  baseURL: string;
  secret: string;
  google?: Pick<GoogleOptions, "clientId" | "clientSecret"> & GoogleProviderOverrides;
  /** Next.js-only plugins (e.g. `nextCookies()`) that depend on `next/headers` request scope and
   * so cannot be part of the instance packages/auth's own tests construct — see the package's
   * README/plan notes on why `nextCookies()` lives here, not inside this factory. */
  extraPlugins?: BetterAuthPlugin[];
  /** Runs `sendVerificationOTP`'s email delivery after the HTTP response has already been sent
   * (Next's `after()`, passed in by apps/admin — not available outside a request-scoped runtime,
   * so it can't be constructed inside this framework-agnostic package). Without this, an
   * unknown/inactive/throttled email (near-instant no-op) and a real one (awaits a real network
   * send) are observably different response times — a timing side-channel that defeats the
   * "same response either way" design even though the response BODY is already identical. When
   * omitted (e.g. in this package's own tests), the send is simply awaited inline. */
  backgroundTaskHandler?: (promise: Promise<unknown>) => void;
  /** Test-only escape hatch (same spirit as `GoogleProviderOverrides` above): hands a freshly
   * generated sign-in OTP to the caller as a structured value, for a test harness that needs to
   * capture it without parsing it back out of the rendered email body/subject (which couples the
   * harness to free-text copy that's expected to change independently). Called right alongside
   * `emailSender.send`, for the same `sign-in` OTPs only. Never set in production. */
  onOtpGenerated?: (params: { email: string; otp: string }) => void;
  /** Whole-system OTP-send cap per hour (see OTP_GLOBAL_WINDOW_SECONDS above) — defaults to
   * DEFAULT_OTP_GLOBAL_HOURLY_CAP. apps/admin passes OTP_GLOBAL_HOURLY_CAP from the environment
   * so this can be tuned without a code change once real send volume is known. */
  globalHourlyCap?: number;
  /** Test-only escape hatch (same spirit as `onOtpGenerated`): overrides the real 5-minute
   * expiry (OTP_EXPIRES_IN_SECONDS) so an e2e run can make a code expire in a couple of real
   * seconds instead of 5 real minutes, to test that an expired code is actually rejected. Never
   * set in production — apps/admin only ever reads this from an env var gated behind the same
   * E2E_TEST_LOGIN flag everything else in this test-only surface requires. */
  expiresInSecondsOverride?: number;
  /** Test-only escape hatch — skips the per-email cooldown/cap and global-cap checks entirely
   * (the send always goes through, as if every one of those were unlimited). Exists ONLY for
   * apps/admin's `e2eSignInAuth` (its own instant-sign-in test backdoor, never real staff/
   * customer traffic): that backdoor's own retries can legitimately resend for the SAME e2e
   * fixture email within the real 60s cooldown window, which would otherwise suppress the very
   * thing the backdoor exists to produce. The real `staffAuth`/`customerAuth` instance never
   * sets this, even in e2e mode — login-otp.spec.ts specifically needs the REAL throttle
   * behavior to still apply there. Never set in production. */
  disableSendThrottle?: boolean;
  /** The Ammari logo for the sign-in code email's header: an absolute https URL on the storefront
   * (@ammari/email `emailLogoUrl`), or null/omitted for the text wordmark only. */
  emailLogoUrl?: string | null;
}

export function createStaffAuth(options: CreateStaffAuthOptions) {
  const {
    db,
    emailSender,
    baseURL,
    secret,
    google,
    extraPlugins = [],
    backgroundTaskHandler,
    onOtpGenerated,
    globalHourlyCap = DEFAULT_OTP_GLOBAL_HOURLY_CAP,
    expiresInSecondsOverride,
    disableSendThrottle = false,
    emailLogoUrl = null,
  } = options;
  const otpExpiresInSeconds = expiresInSecondsOverride ?? OTP_EXPIRES_IN_SECONDS;

  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error(
      "STAFF_BETTER_AUTH_SECRET is not set. Required in production — refusing to start with a " +
        "fallback secret for an auth instance.",
    );
  }

  return betterAuth({
    baseURL,
    secret,
    basePath: "/api/auth",
    trustedOrigins: [baseURL],
    // Our Drizzle tables already use the real `staff_auth_*` physical names (see
    // packages/db/src/schema/staff-auth.ts) and already match Better Auth's default column
    // names exactly, so the only wiring needed is wiring the adapter's generic model keys
    // ("user", "session", ...) to our concretely-named tables — no `modelName`/`fields` remap
    // needed on top of this.
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
        user: schema.staffAuthUsers,
        session: schema.staffAuthSessions,
        account: schema.staffAuthAccounts,
        verification: schema.staffAuthVerifications,
        rateLimit: schema.staffAuthRateLimits,
      },
      usePlural: false,
    }),
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "ammari_staff",
      useSecureCookies: baseURL.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      ...(backgroundTaskHandler ? { backgroundTasks: { handler: backgroundTaskHandler } } : {}),
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        // Per-IP abuse guard only — NOT the resend cooldown (see OTP_IP_ABUSE_MAX's own
        // comment above for why a tight per-IP rule is unsafe behind Indonesian CGNAT). The
        // actual resend cooldown is enforced per-email, inside sendVerificationOTP below.
        "/email-otp/send-verification-otp": { window: OTP_IP_ABUSE_WINDOW_SECONDS, max: OTP_IP_ABUSE_MAX },
        "/sign-in/email-otp": { window: VERIFY_RATE_LIMIT_WINDOW_SECONDS, max: VERIFY_RATE_LIMIT_MAX },
      },
    },
    user: {
      additionalFields: {
        staffUserId: { type: "string", required: false, input: false },
      },
      // The single admission gate for EVERY authentication method (create-user, link-account,
      // and OAuth sign-in) — see the plan's §2 revision for why this replaces
      // disableSignUp/disableImplicitSignUp (both block the row Better Auth needs to create on a
      // legitimate staff member's very first login, before our own hooks ever get to run).
      validateUserInfo: async ({ user, source }) => {
        if (!user.email) return { error: "invalid_account" };
        // A Google profile whose email Google itself has not verified proves nothing about who
        // owns the address (docs/plans/roles-staff.md §8). Better Auth's Google provider passes
        // the profile's `email_verified` through as `emailVerified`; refuse anything but true.
        if (source.method === "oauth" && user.emailVerified !== true) return { error: "invalid_account" };
        const staff = await loadActiveStaffForEmail(db, user.email);
        if (!staff) return { error: "invalid_account" };
      },
    },
    ...(google ? { socialProviders: { google } } : {}),
    databaseHooks: {
      user: {
        create: {
          // Reachable only after validateUserInfo already allowed this email, but re-checks
          // defensively rather than assuming — never trust that two hooks stay in sync by
          // construction alone.
          before: async (user) => {
            if (!user.email) return false;
            const staff = await loadActiveStaffForEmail(db, user.email);
            if (!staff) return false;
            return { data: { staffUserId: staff.id } };
          },
        },
      },
      session: {
        create: {
          // The live re-check for returning sign-ins that validateUserInfo does not cover (its
          // own doc comment calls out exactly this gap) — this is what makes an inactive staff
          // member's NEXT login attempt (not just their already-issued cookie) fail immediately.
          before: async (session) => {
            const active = await isActiveStaffAuthUser(db, session.userId);
            if (!active) return false;
          },
          after: async (session) => {
            await markStaffLastLogin(db, session.userId);
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: otpExpiresInSeconds,
        allowedAttempts: OTP_MAX_ATTEMPTS,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return; // staff has no password/email-change flow to gate here
          // See disableSendThrottle's own doc comment — skipped only by apps/admin's own
          // instant-sign-in e2e backdoor, never by this (the real) instance.
          if (!disableSendThrottle) {
            // One atomic insert decides all three outcomes below — see recordEmailThrottleAttempt's
            // own doc comment for why none of the returned counts include this attempt's own row.
            const decision = await recordEmailThrottleAttempt(db, email, {
              cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
              capWindowSeconds: OTP_SEND_WINDOW_SECONDS,
              globalWindowSeconds: OTP_GLOBAL_WINDOW_SECONDS,
            });
            if (decision.priorGlobalAttempts >= globalHourlyCap) {
              // Loud on purpose (not a silent no-op from an operational standpoint) — this is
              // the whole-system circuit breaker tripping, which should page/alert, not blend
              // into the same quiet log line every throttled individual send already produces.
              // Still a silent no-op to the CALLER (same response shape as every other case
              // here) — this is a Resend-quota/sender-reputation protection, not an enumeration
              // boundary, but there's no reason to treat it differently from the caller's point
              // of view either.
              console.error(
                `[staff-auth] GLOBAL OTP send cap reached (${globalHourlyCap}/${OTP_GLOBAL_WINDOW_SECONDS}s) — suppressing send for ${email}`,
              );
              return;
            }
            if (decision.cooldownActive) return; // resent sooner than OTP_RESEND_COOLDOWN_SECONDS
            if (decision.priorAttemptsInCapWindow >= OTP_SEND_MAX_PER_WINDOW) return; // same no-op as an invalid email
          }

          const staff = await loadActiveStaffForEmail(db, email);
          if (!staff) return; // same no-op — no enumeration signal either way

          await emailSender.send(
            signInCodeMessage({ audience: "staff", to: email, otp, expiresInSeconds: otpExpiresInSeconds, logoUrl: emailLogoUrl }),
          );
          onOtpGenerated?.({ email, otp });
        },
      }),
      ...extraPlugins,
    ],
  });
}

export type StaffAuth = ReturnType<typeof createStaffAuth>;

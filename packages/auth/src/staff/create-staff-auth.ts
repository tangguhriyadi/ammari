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
  recordEmailThrottleAttemptAndCount,
} from "./staff-data";

// 5 minutes / 6 digits / 5 attempts: CLAUDE.md's OTP rules.
const OTP_EXPIRES_IN_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
// Per-email send throttle (see schema/auth-throttle.ts) — intentionally the same window as OTP
// expiry, so "5 codes alive at once" and "5 sends per window" line up.
const OTP_SEND_WINDOW_SECONDS = 5 * 60;
const OTP_SEND_MAX_PER_WINDOW = 5;
// Better Auth's own IP-keyed limiter (separate mechanism, see §3 of the plan) on top of the above.
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
}

export function createStaffAuth(options: CreateStaffAuthOptions) {
  const { db, emailSender, baseURL, secret, google, extraPlugins = [], backgroundTaskHandler } = options;

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
        "/email-otp/send-verification-otp": { window: OTP_SEND_WINDOW_SECONDS, max: OTP_SEND_MAX_PER_WINDOW },
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
      validateUserInfo: async ({ user }) => {
        if (!user.email) return { error: "invalid_account" };
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
        expiresIn: OTP_EXPIRES_IN_SECONDS,
        allowedAttempts: OTP_MAX_ATTEMPTS,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return; // staff has no password/email-change flow to gate here
          // `priorAttempts` excludes the row this call just inserted (see the function's doc
          // comment) — reaching the limit (not exceeding it) is what blocks the Nth+1 attempt.
          const priorAttempts = await recordEmailThrottleAttemptAndCount(db, email, OTP_SEND_WINDOW_SECONDS);
          if (priorAttempts >= OTP_SEND_MAX_PER_WINDOW) return; // same no-op as an invalid email

          const staff = await loadActiveStaffForEmail(db, email);
          if (!staff) return; // same no-op — no enumeration signal either way

          await emailSender.send({
            to: email,
            subject: "Kode masuk Ammari Admin",
            body: `Kode masuk kamu: ${otp}\n\nBerlaku 5 menit. Jangan bagikan kode ini ke siapa pun.`,
          });
        },
      }),
      ...extraPlugins,
    ],
  });
}

export type StaffAuth = ReturnType<typeof createStaffAuth>;

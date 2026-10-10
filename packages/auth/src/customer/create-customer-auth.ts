import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { GoogleOptions } from "better-auth/social-providers";
import * as schema from "@ammari/db/schema";
import type { EmailSender } from "../email-sender";
import { recordEmailThrottleAttemptAndCount } from "../shared/email-throttle";
import { type Database, loadOrCreateCustomerForEmail } from "./customer-data";

// 5 minutes / 6 digits / 5 attempts: CLAUDE.md's OTP rules — same hardening as staff.
const OTP_EXPIRES_IN_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SEND_WINDOW_SECONDS = 5 * 60;
const OTP_SEND_MAX_PER_WINDOW = 5;
const VERIFY_RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const VERIFY_RATE_LIMIT_MAX = 10;

// ~60 days, sliding (decided rule) — updateAge kept at the same 1-day grain staff uses (1/7 of
// its 7-day session) so the window actually behaves like a slide rather than only renewing once
// near expiry.
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 60; // 60 days
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24; // 1 day

// Test-only escape hatches — same purpose as staff's GoogleProviderOverrides (see that file's
// own doc comment): real better-auth GoogleOptions fields used to stub the token-exchange/
// profile-fetch boundary in tests. Never set in production.
export type GoogleProviderOverrides = Pick<GoogleOptions, "getUserInfo" | "verifyIdToken">;

export interface CreateCustomerAuthOptions {
  db: Database;
  emailSender: EmailSender;
  /** The main site's own origin, e.g. "https://ammari.id" or "http://localhost:3000". Used as
   * both `baseURL` and the sole entry of `trustedOrigins` — never derived from a request
   * header. */
  baseURL: string;
  secret: string;
  google?: Pick<GoogleOptions, "clientId" | "clientSecret"> & GoogleProviderOverrides;
  /** Next.js-only plugins (e.g. `nextCookies()`) — see staff's own factory for why these live
   * here rather than inside this framework-agnostic package. */
  extraPlugins?: BetterAuthPlugin[];
  /** Runs `sendVerificationOTP`'s email delivery after the HTTP response has already been sent
   * (Next's `after()`) — see staff's own factory for the full reasoning (closes a timing side
   * channel). Awaited inline when omitted (e.g. this package's own tests). */
  backgroundTaskHandler?: (promise: Promise<unknown>) => void;
  /** Test-only escape hatch — hands a freshly generated sign-in OTP to the caller as a
   * structured value, same purpose as staff's own `onOtpGenerated`. Never set in production. */
  onOtpGenerated?: (params: { email: string; otp: string }) => void;
}

export function createCustomerAuth(options: CreateCustomerAuthOptions) {
  const { db, emailSender, baseURL, secret, google, extraPlugins = [], backgroundTaskHandler, onOtpGenerated } = options;

  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error(
      "CUSTOMER_BETTER_AUTH_SECRET is not set. Required in production — refusing to start with " +
        "a fallback secret for an auth instance.",
    );
  }

  return betterAuth({
    baseURL,
    secret,
    basePath: "/api/auth",
    trustedOrigins: [baseURL],
    // Our Drizzle tables already use the real customer_auth_* physical names (see
    // packages/db/src/schema/customer-auth.ts) and already match Better Auth's default column
    // names — same wiring as the staff instance, just pointed at the customer_auth_* tables.
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
        user: schema.customerAuthUsers,
        session: schema.customerAuthSessions,
        account: schema.customerAuthAccounts,
        verification: schema.customerAuthVerifications,
        rateLimit: schema.customerAuthRateLimits,
      },
      usePlural: false,
    }),
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "ammari_customer",
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
        customerId: { type: "string", required: false, input: false },
      },
      // Deliberately NO validateUserInfo gate here — the opposite of staff's closed admission
      // gate. Self sign-up is allowed for anyone; databaseHooks.user.create.before below decides
      // link-vs-create, not admission.
    },
    ...(google ? { socialProviders: { google } } : {}),
    databaseHooks: {
      user: {
        create: {
          // The one real behavioral fork from staff's equivalent hook (see
          // customer-data.ts's own doc comment): creates a fresh `customers` row when no email
          // match exists, instead of only ever linking/rejecting.
          before: async (user) => {
            if (!user.email) return false;
            const identity = await loadOrCreateCustomerForEmail(db, {
              email: user.email,
              name: user.name || "Pelanggan Ammari",
              emailVerified: Boolean(user.emailVerified),
            });
            if (!identity) return false;
            return { data: { customerId: identity.id } };
          },
        },
      },
      // No session.create hooks: unlike staff_users, customers has no is_active/deactivation
      // concept to re-check live, and no last_login_at column to stamp in v1.
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_EXPIRES_IN_SECONDS,
        allowedAttempts: OTP_MAX_ATTEMPTS,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return; // customers have no password/email-change flow here either
          // Same throttle table/helper the staff instance uses (see shared/email-throttle.ts) —
          // no "unknown email" no-op branch needed here, unlike staff: self sign-up means every
          // email is eligible, so the OTP is always actually sent once under the throttle cap.
          const priorAttempts = await recordEmailThrottleAttemptAndCount(db, email, OTP_SEND_WINDOW_SECONDS);
          if (priorAttempts >= OTP_SEND_MAX_PER_WINDOW) return;

          try {
            await emailSender.send({
              to: email,
              subject: "Kode masuk Ammari",
              body: `Kode masuk kamu: ${otp}\n\nBerlaku 5 menit. Jangan bagikan kode ini ke siapa pun.`,
            });
          } catch (error) {
            // better-auth's own endpoint (dist/plugins/email-otp/routes.mjs) unconditionally
            // returns `{ success: true }` regardless of whether this promise rejects — it runs
            // this whole callback through `runInBackgroundOrAwait`, which catches and logs any
            // rejection itself, never rethrowing to the caller (confirmed by reading
            // dist/context/create-context.mjs). That's a structural property of the plugin, not
            // something apps/web's own backgroundTaskHandler config controls either way — a
            // misconfigured/down email provider in production (e.g. UnconfiguredEmailSender
            // throwing exactly as designed) is otherwise indistinguishable from a real send in
            // the HTTP response. This explicit, distinctly-prefixed log is the most this layer
            // can do to make that failure actually discoverable in production logs, separate
            // from better-auth's own generic "Failed to run background task" line.
            console.error(`[customer-auth] OTP email send failed for ${email}:`, error);
            throw error;
          }
          onOtpGenerated?.({ email, otp });
        },
      }),
      ...extraPlugins,
    ],
  });
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;

import "server-only";
import { after } from "next/server";
import { nextCookies } from "better-auth/next-js";
import { createCustomerAuth } from "@ammari/auth/customer";
import { ConsoleEmailSender, ResendEmailSender, UnconfiguredEmailSender } from "@ammari/auth";
import { db } from "@ammari/db";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function emailSender() {
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

export const customerAuth = createCustomerAuth({
  db,
  emailSender: emailSender(),
  baseURL,
  secret,
  google,
  extraPlugins: [nextCookies()],
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
  backgroundTaskHandler: (promise) => after(() => promise),
});

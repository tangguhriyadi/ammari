import "server-only";
import { after } from "next/server";
import { nextCookies } from "better-auth/next-js";
import { createStaffAuth } from "@ammari/auth/staff";
import { ConsoleEmailSender, UnconfiguredEmailSender } from "@ammari/auth";
import { db } from "@ammari/db";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function emailSender() {
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

export const staffAuth = createStaffAuth({
  db,
  emailSender: emailSender(),
  baseURL: requiredEnv("BETTER_AUTH_URL"),
  secret: process.env.STAFF_BETTER_AUTH_SECRET ?? "",
  google: googleConfig(),
  extraPlugins: [nextCookies()],
  // Runs sendVerificationOTP's whole body (throttle check + staff lookup + email send) after the
  // HTTP response is already sent, so an unknown/inactive/throttled email and a real one take
  // the same (near-zero) time from the caller's perspective — closes the timing side-channel a
  // synchronously-awaited email send would otherwise open. Next's after() works in Route
  // Handlers on a self-hosted Node server, not just serverless platforms.
  backgroundTaskHandler: (promise) => after(() => promise),
});

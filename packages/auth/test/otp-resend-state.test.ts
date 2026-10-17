import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { authEmailThrottle, customerAuthVerifications, staffAuthVerifications } from "@ammari/db/schema";
import { getCustomerOtpResendState } from "../src/customer";
import { getStaffOtpResendState } from "../src/staff";
import { OTP_RESEND_COOLDOWN_SECONDS } from "../src/shared/otp-timing";
import { buildCustomerAuth, cleanupCustomerAuthTables, testDb } from "./customer-setup";
import { buildStaffAuth, cleanupAuthTables, cleanupStaffUsers, createCommittedStaffUser } from "./setup";

/** Same technique as staff-auth.test.ts's own `backdateThrottleRows` — real elapsed time between
 * sends without a real wait, since the cooldown is computed against Postgres's own `now()`. */
async function backdateThrottleRows(email: string, seconds: number): Promise<void> {
  await testDb
    .update(authEmailThrottle)
    .set({ createdAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(authEmailThrottle.email, email));
}

describe("getCustomerOtpResendState (web)", () => {
  afterEach(async () => {
    await cleanupCustomerAuthTables();
  });

  test("no prior send at all: no cooldown, no active code", async () => {
    const email = `resend-none-${Date.now()}@example.test`;
    const state = await getCustomerOtpResendState(testDb, email);
    expect(state).toEqual({ cooldownRemainingSeconds: 0, hasActiveCode: false });
  });

  test("Case A — an immediate resend attempt while the first code is still unexpired and unused", async () => {
    const email = `resend-case-a-${Date.now()}@example.test`;
    const { auth } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });

    const state = await getCustomerOtpResendState(testDb, email);
    expect(state.hasActiveCode).toBe(true);
    expect(state.cooldownRemainingSeconds).toBeGreaterThan(0);
    expect(state.cooldownRemainingSeconds).toBeLessThanOrEqual(OTP_RESEND_COOLDOWN_SECONDS);
  });

  test("Case B — the first code was already consumed by a successful sign-in", async () => {
    const email = `resend-case-b-consumed-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email, otp } });

    const state = await getCustomerOtpResendState(testDb, email);
    expect(state.hasActiveCode).toBe(false);
    expect(state.cooldownRemainingSeconds).toBeGreaterThan(0);
  });

  test("Case B — the first code expired", async () => {
    const email = `resend-case-b-expired-${Date.now()}@example.test`;
    const { auth } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    await testDb
      .update(customerAuthVerifications)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(customerAuthVerifications.identifier, `sign-in-otp-${email}`));

    const state = await getCustomerOtpResendState(testDb, email);
    expect(state.hasActiveCode).toBe(false);
    expect(state.cooldownRemainingSeconds).toBeGreaterThan(0);
  });

  test("Case B — the code was invalidated after 5 wrong attempts", async () => {
    const email = `resend-case-b-locked-${Date.now()}@example.test`;
    const { auth } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    // 5 wrong guesses recreate the row each time with an incremented attempt count (still
    // usable); the 6th is the one that actually finds `usedAttempts >= allowedAttempts` and
    // leaves the row deleted — see better-auth's own `atomicVerifyOTP` (dist/plugins/email-otp/
    // routes.mjs).
    for (let attempt = 1; attempt <= 6; attempt++) {
      await expect(auth.api.signInEmailOTP({ body: { email, otp: "000000" } })).rejects.toThrow();
    }

    const state = await getCustomerOtpResendState(testDb, email);
    expect(state.hasActiveCode).toBe(false);
    expect(state.cooldownRemainingSeconds).toBeGreaterThan(0);
  });

  test("once the 60s cooldown itself has cleared, no restriction applies regardless of code state", async () => {
    const email = `resend-cleared-${Date.now()}@example.test`;
    const { auth } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    await backdateThrottleRows(email, 61);

    const state = await getCustomerOtpResendState(testDb, email);
    expect(state).toEqual({ cooldownRemainingSeconds: 0, hasActiveCode: false });
  });

  test("email is matched case-insensitively and trimmed", async () => {
    const email = `Resend-Case-${Date.now()}@Example.Test`;
    const { auth } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });

    const state = await getCustomerOtpResendState(testDb, `  ${email.toUpperCase()}  `);
    expect(state.hasActiveCode).toBe(true);
  });
});

describe("getStaffOtpResendState (admin)", () => {
  let staffUserIds: string[] = [];

  beforeEach(() => {
    staffUserIds = [];
  });

  afterEach(async () => {
    await cleanupAuthTables();
    await cleanupStaffUsers(staffUserIds);
  });

  test("no prior send at all: no cooldown, no active code", async () => {
    const email = `staff-resend-none-${Date.now()}@example.test`;
    const state = await getStaffOtpResendState(testDb, email);
    expect(state).toEqual({ cooldownRemainingSeconds: 0, hasActiveCode: false });
  });

  test("Case A — an immediate resend attempt while the first code is still unexpired and unused", async () => {
    const staffUser = await createCommittedStaffUser();
    staffUserIds.push(staffUser.id);
    const { auth } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staffUser.email, type: "sign-in" } });

    const state = await getStaffOtpResendState(testDb, staffUser.email);
    expect(state.hasActiveCode).toBe(true);
    expect(state.cooldownRemainingSeconds).toBeGreaterThan(0);
  });

  test("Case B — the first code was already consumed by a successful sign-in", async () => {
    const staffUser = await createCommittedStaffUser();
    staffUserIds.push(staffUser.id);
    const { auth, emailSender } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staffUser.email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email: staffUser.email, otp } });

    const state = await getStaffOtpResendState(testDb, staffUser.email);
    expect(state.hasActiveCode).toBe(false);
    expect(state.cooldownRemainingSeconds).toBeGreaterThan(0);
  });

  test("Case B — the first code expired", async () => {
    const staffUser = await createCommittedStaffUser();
    staffUserIds.push(staffUser.id);
    const { auth } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staffUser.email, type: "sign-in" } });
    await testDb
      .update(staffAuthVerifications)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(staffAuthVerifications.identifier, `sign-in-otp-${staffUser.email}`));

    const state = await getStaffOtpResendState(testDb, staffUser.email);
    expect(state.hasActiveCode).toBe(false);
    expect(state.cooldownRemainingSeconds).toBeGreaterThan(0);
  });

  test("once the 60s cooldown itself has cleared, no restriction applies regardless of code state", async () => {
    const staffUser = await createCommittedStaffUser();
    staffUserIds.push(staffUser.id);
    const { auth } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staffUser.email, type: "sign-in" } });
    await backdateThrottleRows(staffUser.email, 61);

    const state = await getStaffOtpResendState(testDb, staffUser.email);
    expect(state).toEqual({ cooldownRemainingSeconds: 0, hasActiveCode: false });
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { authEmailThrottle, staffAuthUsers, staffUsers } from "@ammari/db/schema";
import { isActiveStaffAuthUser, loadStaffSessionData } from "../src/staff";
import {
  buildStaffAuth,
  cleanupAuthTables,
  cleanupStaffUsers,
  createCommittedStaffUser,
  testDb,
} from "./setup";

/** Backdates every existing throttle row for `email` by `seconds` — simulates real elapsed time
 * between sends without a real wait, same technique the "expired OTP" test below uses on
 * `expires_at`. Needed because the cooldown/cap windows are computed against Postgres's own
 * `now()` (see shared/email-throttle.ts), which vitest's fake timers can't reach. */
async function backdateThrottleRows(email: string, seconds: number): Promise<void> {
  await testDb
    .update(authEmailThrottle)
    .set({ createdAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(authEmailThrottle.email, email));
}

let staffUserIds: string[] = [];

beforeEach(() => {
  staffUserIds = [];
});

afterEach(async () => {
  await cleanupAuthTables();
  await cleanupStaffUsers(staffUserIds);
});

describe("email OTP sign-in — the staff gate", () => {
  test("unknown email: send is a silent no-op, no email delivered", async () => {
    const { auth, emailSender } = buildStaffAuth();
    const result = await auth.api.sendVerificationOTP({
      body: { email: "nobody@example.test", type: "sign-in" },
    });
    expect(result.success).toBe(true); // same response shape as a real send
    expect(emailSender.sent).toHaveLength(0);
  });

  test("unknown email: verify fails the same way a wrong code would", async () => {
    const { auth } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: "nobody@example.test", type: "sign-in" } });
    await expect(
      auth.api.signInEmailOTP({ body: { email: "nobody@example.test", otp: "000000" } }),
    ).rejects.toThrow();
  });

  test("inactive staff: send is a silent no-op, no email delivered", async () => {
    const staff = await createCommittedStaffUser({ isActive: false });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    const result = await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(result.success).toBe(true);
    expect(emailSender.sent).toHaveLength(0);
  });

  test("inactive staff: verify fails", async () => {
    const staff = await createCommittedStaffUser({ isActive: false });
    staffUserIds.push(staff.id);
    const { auth } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    await expect(
      auth.api.signInEmailOTP({ body: { email: staff.email, otp: "000000" } }),
    ).rejects.toThrow();
  });

  test("active staff: first-ever OTP login succeeds and stamps staff_user_id", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(emailSender.sent).toHaveLength(1);
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0];
    expect(otp).toBeTruthy();

    const result = await auth.api.signInEmailOTP({ body: { email: staff.email, otp: otp! } });
    expect(result.user.email).toBe(staff.email.toLowerCase());

    const [row] = await testDb.select().from(staffAuthUsers).where(eq(staffAuthUsers.email, staff.email));
    expect(row?.staffUserId).toBe(staff.id);
  });

  test("6th wrong OTP attempt is rejected (allowedAttempts: 5)", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(
        auth.api.signInEmailOTP({ body: { email: staff.email, otp: "999999" } }),
      ).rejects.toThrow();
    }
    // A 6th attempt — even if it somehow guessed right — must still be rejected because the
    // verification record was already locked out after the 5th wrong attempt.
    await expect(
      auth.api.signInEmailOTP({ body: { email: staff.email, otp: "999999" } }),
    ).rejects.toThrow();
  });

  test("an expired OTP is rejected", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;

    // Force the stored verification row into the past rather than waiting 5 real minutes.
    await testDb.execute(
      `update staff_auth_verifications set expires_at = now() - interval '1 second' where identifier like '%sign-in%'`,
    );

    await expect(auth.api.signInEmailOTP({ body: { email: staff.email, otp } })).rejects.toThrow();
  });
});

// docs/plans/roles-staff.md §3: a staff_users row is the invitation; one that was never used
// before its invite_expires_at is treated exactly like an unknown email.
describe("invitation expiry — the staff gate", () => {
  const PAST = () => new Date(Date.now() - 60_000);
  const FUTURE = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  test("an expired, never-used invitation: send is a silent no-op and verify fails", async () => {
    const staff = await createCommittedStaffUser({ inviteExpiresAt: PAST() });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    const result = await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(result.success).toBe(true); // same response shape as a real send
    expect(emailSender.sent).toHaveLength(0);
    await expect(auth.api.signInEmailOTP({ body: { email: staff.email, otp: "000000" } })).rejects.toThrow();
  });

  test("an unexpired invitation logs in, and the expiry stops mattering after the first login", async () => {
    const staff = await createCommittedStaffUser({ inviteExpiresAt: FUTURE() });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email: staff.email, otp } });

    const [row] = await testDb.select().from(staffUsers).where(eq(staffUsers.id, staff.id));
    expect(row?.lastLoginAt).not.toBeNull();
    // Expire the invitation after the fact: a returning staff member is unaffected.
    await testDb.update(staffUsers).set({ inviteExpiresAt: PAST() }).where(eq(staffUsers.id, staff.id));
    const [authUser] = await testDb.select().from(staffAuthUsers).where(eq(staffAuthUsers.staffUserId, staff.id));
    expect(await isActiveStaffAuthUser(testDb, authUser!.id)).toBe(true);
  });

  test("a row with no expiry (pre-0041 rows, seed accounts) is admitted", async () => {
    const staff = await createCommittedStaffUser();
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(emailSender.sent).toHaveLength(1);
  });

  test("a session for a never-logged-in row is refused once its invitation has expired", async () => {
    const staff = await createCommittedStaffUser({ inviteExpiresAt: FUTURE() });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();
    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email: staff.email, otp } });
    const [authUser] = await testDb.select().from(staffAuthUsers).where(eq(staffAuthUsers.staffUserId, staff.id));

    // Simulate "auth row exists but last_login_at never got stamped": the live gate must still
    // apply the expiry.
    await testDb.update(staffUsers).set({ lastLoginAt: null, inviteExpiresAt: PAST() }).where(eq(staffUsers.id, staff.id));
    expect(await isActiveStaffAuthUser(testDb, authUser!.id)).toBe(false);
  });
});

describe("per-email OTP send cooldown + cap (auth_email_throttle)", () => {
  test("resending within 60s is a silent no-op; past 60s it succeeds and restarts the code", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    const firstOtp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;

    // Immediate resend: cooldown still active — same silent-no-op shape as every other
    // throttle outcome, no email actually sent a second time.
    const immediate = await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(immediate).toEqual({ success: true });
    expect(emailSender.sent).toHaveLength(1);

    await backdateThrottleRows(staff.email, 61);
    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(emailSender.sent).toHaveLength(2);
    const secondOtp = emailSender.sent[1]!.body.match(/\d{6}/)?.[0]!;
    expect(secondOtp).not.toBe(firstOtp);

    // The resend invalidated the first code (unique index on `identifier` — see
    // packages/db/src/schema/staff-auth.ts), it didn't just add a second valid one alongside it.
    await expect(auth.api.signInEmailOTP({ body: { email: staff.email, otp: firstOtp } })).rejects.toThrow();
    const result = await auth.api.signInEmailOTP({ body: { email: staff.email, otp: secondOtp } });
    expect(result.user.email).toBe(staff.email.toLowerCase());
  });

  test("a 6th send within the 5-per-5-minute cap is suppressed even once the cooldown has cleared", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    // Directly seed 5 prior attempts rather than firing 5 real sendVerificationOTP calls 60s
    // apart: 5 sends spaced exactly at the 60s cooldown boundary span exactly 240s, leaving the
    // very first row right at the edge of also aging out of the 300s cap window by the time a
    // 6th, cooldown-clear attempt could fire — seeding deterministic ages isolates the CAP from
    // the COOLDOWN instead of fighting that boundary.
    for (const ageSeconds of [250, 200, 150, 100, 65]) {
      await testDb.insert(authEmailThrottle).values({ email: staff.email, createdAt: sql`now() - make_interval(secs => ${ageSeconds})` });
    }

    const response = await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(response).toEqual({ success: true });
    expect(emailSender.sent).toHaveLength(0); // the cap suppressed it, not the (already-clear) cooldown
  });

  test("the cooldown/cap counts attempts for unknown emails identically (no enumeration signal)", async () => {
    const { auth, emailSender } = buildStaffAuth();
    const first = await auth.api.sendVerificationOTP({ body: { email: "nobody@example.test", type: "sign-in" } });
    const second = await auth.api.sendVerificationOTP({ body: { email: "nobody@example.test", type: "sign-in" } });
    expect(emailSender.sent).toHaveLength(0); // never a real staff member — 0 either way
    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true }); // cooldown-suppressed, identical shape regardless
  });
});

describe("whole-system OTP send cap (circuit breaker, shared across staff + customer)", () => {
  test("suppresses a send even for a fresh email with no prior attempts of its own, and logs loudly", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth, emailSender } = buildStaffAuth({ globalHourlyCap: 3 });

    // 3 unrelated attempts (different emails) within the last hour trips the cap for ANY email.
    for (const email of ["a@example.test", "b@example.test", "c@example.test"]) {
      await testDb.insert(authEmailThrottle).values({ email });
    }

    const response = await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(response).toEqual({ success: true });
    expect(emailSender.sent).toHaveLength(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("GLOBAL OTP send cap reached"));
    consoleErrorSpy.mockRestore();
  });
});

describe("per-IP send abuse guard — CF-Connecting-IP only, never X-Forwarded-For", () => {
  // Exercises the real HTTP handler (not `auth.api.*`, which bypasses Better Auth's own
  // rate-limit middleware entirely — see lib/auth/client.ts's own comment on why the login UI
  // calls real HTTP endpoints for exactly this reason). No Origin/Referer/Sec-Fetch/Cookie
  // headers are sent, so Better Auth's form-CSRF check no-ops (confirmed by reading
  // dist/api/middlewares/origin-check.mjs's `validateFormCsrf`) without needing to fake a
  // trusted origin for every call.
  function sendOtpRequest(auth: ReturnType<typeof buildStaffAuth>["auth"], email: string, headers: Record<string, string>) {
    return auth.handler(
      new Request("http://localhost:3001/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
    );
  }

  test("20 sends from the same CF-Connecting-IP succeed, the 21st is rate-limited", async () => {
    const { auth } = buildStaffAuth();
    const ip = "203.0.113.10";
    for (let i = 0; i < 20; i++) {
      const response = await sendOtpRequest(auth, `cf-ip-${i}@example.test`, { "cf-connecting-ip": ip });
      expect(response.status).toBe(200);
    }
    const response = await sendOtpRequest(auth, "cf-ip-20@example.test", { "cf-connecting-ip": ip });
    expect(response.status).toBe(429);
  });

  test("varying X-Forwarded-For alone never grants a fresh IP bucket", async () => {
    const { auth } = buildStaffAuth();
    // No cf-connecting-ip on any of these — if X-Forwarded-For were used as the rate-limit key,
    // each distinct value below would get its own bucket and none of this would ever trip the
    // limit. It's ignored, so all 21 share whatever single fallback IP getIP() resolves to
    // absent a configured header, and the 21st is still blocked.
    for (let i = 0; i < 20; i++) {
      const response = await sendOtpRequest(auth, `xff-${i}@example.test`, { "x-forwarded-for": `198.51.100.${i}` });
      expect(response.status).toBe(200);
    }
    const response = await sendOtpRequest(auth, "xff-20@example.test", { "x-forwarded-for": "198.51.100.20" });
    expect(response.status).toBe(429);
  });

  test("a different CF-Connecting-IP gets its own, unblocked bucket", async () => {
    const { auth } = buildStaffAuth();
    for (let i = 0; i < 20; i++) {
      await sendOtpRequest(auth, `busy-ip-${i}@example.test`, { "cf-connecting-ip": "203.0.113.20" });
    }
    const blocked = await sendOtpRequest(auth, "busy-ip-20@example.test", { "cf-connecting-ip": "203.0.113.20" });
    expect(blocked.status).toBe(429);

    const fresh = await sendOtpRequest(auth, "fresh-ip@example.test", { "cf-connecting-ip": "203.0.113.30" });
    expect(fresh.status).toBe(200);
  });
});

describe("session.create.before — live is_active re-check", () => {
  test("a staff member deactivated after their auth row exists is rejected on their next session", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email: staff.email, otp } });

    const [authUser] = await testDb.select().from(staffAuthUsers).where(eq(staffAuthUsers.email, staff.email));
    expect(await isActiveStaffAuthUser(testDb, authUser!.id)).toBe(true);

    await testDb.update(staffUsers).set({ isActive: false }).where(eq(staffUsers.id, staff.id));

    // This is the exact check `databaseHooks.session.create.before` runs on every new session,
    // and what getStaffSession() in apps/admin re-runs on every request — it must flip to false
    // immediately, with no caching in between.
    expect(await isActiveStaffAuthUser(testDb, authUser!.id)).toBe(false);

    // And a brand-new login attempt (not just re-use of an old session) is rejected end-to-end.
    await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } });
    expect(emailSender.sent).toHaveLength(1); // no second email — sendVerificationOTP re-checks too
  });
});

describe("foreign/garbage session tokens", () => {
  test("a token that was never issued by this instance is rejected", async () => {
    const { auth } = buildStaffAuth();
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: "ammari_staff.session_token=not-a-real-token" }),
    });
    expect(session).toBeNull();
  });
});

describe("RBAC permission loading", () => {
  test("a role lacking a permission does not include it", async () => {
    const staff = await createCommittedStaffUser({ isActive: true, roleKey: "owner" });
    staffUserIds.push(staff.id);

    const data = await loadStaffSessionData(testDb, staff.id);
    expect(data).not.toBeNull();
    expect(data!.permissionKeys).toContain("orders.view");
    // owner does not get these by default (docs/SPEC.md §9); staff.manage it does, since
    // migration 0041 (docs/plans/roles-staff.md, owner answer 2)
    expect(data!.permissionKeys).toContain("staff.manage");
    expect(data!.permissionKeys).not.toContain("roles.manage");
    expect(data!.permissionKeys).not.toContain("audit_log.view");
  });

  test("an inactive staff member resolves to null, not a stale permission set", async () => {
    const staff = await createCommittedStaffUser({ isActive: false, roleKey: "owner" });
    staffUserIds.push(staff.id);
    expect(await loadStaffSessionData(testDb, staff.id)).toBeNull();
  });
});

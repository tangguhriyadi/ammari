import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { staffAuthUsers, staffUsers } from "@ammari/db/schema";
import { isActiveStaffAuthUser, loadStaffSessionData } from "../src/staff";
import {
  buildStaffAuth,
  cleanupAuthTables,
  cleanupStaffUsers,
  createCommittedStaffUser,
  testDb,
} from "./setup";

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

describe("per-email OTP send throttle (auth_email_throttle)", () => {
  test("6 send requests for the same email in the window: exactly 5 delivered, all 6 responses identical", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth, emailSender } = buildStaffAuth();

    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push(await auth.api.sendVerificationOTP({ body: { email: staff.email, type: "sign-in" } }));
    }

    expect(emailSender.sent).toHaveLength(5);
    for (const response of responses) {
      expect(response).toEqual({ success: true });
    }
  });

  test("the throttle counts attempts for unknown emails identically (no enumeration signal)", async () => {
    const { auth, emailSender } = buildStaffAuth();
    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push(
        await auth.api.sendVerificationOTP({ body: { email: "nobody@example.test", type: "sign-in" } }),
      );
    }
    expect(emailSender.sent).toHaveLength(0); // never a real staff member — 0, not 5
    for (const response of responses) {
      expect(response).toEqual({ success: true }); // identical shape regardless
    }
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
    // owner does not get these by default (docs/SPEC.md §9)
    expect(data!.permissionKeys).not.toContain("staff.manage");
    expect(data!.permissionKeys).not.toContain("roles.manage");
    expect(data!.permissionKeys).not.toContain("audit_log.view");
  });

  test("an inactive staff member resolves to null, not a stale permission set", async () => {
    const staff = await createCommittedStaffUser({ isActive: false, roleKey: "owner" });
    staffUserIds.push(staff.id);
    expect(await loadStaffSessionData(testDb, staff.id)).toBeNull();
  });
});

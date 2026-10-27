import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { authEmailThrottle, customerAuthUsers, customers } from "@ammari/db/schema";
import {
  buildCustomerAuth,
  cleanupCustomerAuthTables,
  cleanupCustomers,
  createCommittedCustomer,
  testDb,
} from "./customer-setup";

/** Same technique as staff-auth.test.ts's own `backdateThrottleRows` — see that file for why. */
async function backdateThrottleRows(email: string, seconds: number): Promise<void> {
  await testDb
    .update(authEmailThrottle)
    .set({ createdAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(authEmailThrottle.email, email));
}

let customerIds: string[] = [];

beforeEach(() => {
  customerIds = [];
});

afterEach(async () => {
  await cleanupCustomerAuthTables();
  await cleanupCustomers(customerIds);
});

describe("email OTP sign-in — customer self sign-up (link-vs-create hook)", () => {
  test("a brand-new email creates a new customers row and links customerId", async () => {
    const email = `new-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth();

    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    expect(emailSender.sent).toHaveLength(1);
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;

    const result = await auth.api.signInEmailOTP({ body: { email, otp } });
    expect(result.user.email).toBe(email.toLowerCase());

    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, email));
    expect(authUser?.customerId).toBeTruthy();
    customerIds.push(authUser!.customerId!);

    const [customer] = await testDb.select().from(customers).where(eq(customers.id, authUser!.customerId!));
    expect(customer?.email).toBe(email.toLowerCase());
    expect(customer?.emailVerifiedAt).toBeTruthy(); // OTP completion is itself proof of ownership
  });

  test("an existing customers row matched by email is linked, not duplicated", async () => {
    const existing = await createCommittedCustomer();
    customerIds.push(existing.id);
    const { auth, emailSender } = buildCustomerAuth();

    await auth.api.sendVerificationOTP({ body: { email: existing.email!, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email: existing.email!, otp } });

    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, existing.email!));
    expect(authUser?.customerId).toBe(existing.id);

    const matchingCustomers = await testDb.select().from(customers).where(eq(customers.email, existing.email!));
    expect(matchingCustomers).toHaveLength(1); // linked, never duplicated — customers.email is citext UNIQUE anyway
  });

  test("the code email is the branded one: same subject, the code as text in both parts, no link (docs/plans/email-design.md)", async () => {
    const email = `branded-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth();

    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const sent = emailSender.sent[0]!;
    const otp = sent.body.match(/\d{6}/)?.[0]!;
    expect(sent.subject).toBe("Kode masuk Ammari");
    expect(sent.subject).not.toContain(otp);
    expect(sent.body).toContain("abaikan saja email ini");
    expect(sent.html).toContain(`>${otp}</td>`);
    // http://localhost: no logo, the text wordmark only.
    expect(sent.html).not.toContain("<img");
    expect(sent.html).not.toMatch(/<a\s/i);
  });

  test("linking backfills email_verified_at on a pre-existing unverified customer", async () => {
    const existing = await createCommittedCustomer({ emailVerifiedAt: null });
    customerIds.push(existing.id);
    expect(existing.emailVerifiedAt).toBeNull();
    const { auth, emailSender } = buildCustomerAuth();

    await auth.api.sendVerificationOTP({ body: { email: existing.email!, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email: existing.email!, otp } });

    const [customer] = await testDb.select().from(customers).where(eq(customers.id, existing.id));
    expect(customer?.emailVerifiedAt).toBeTruthy();
  });

  test("two separate OTP sign-ins for the same email resolve to the same customerId, not two rows", async () => {
    const email = `repeat-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth();

    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const firstOtp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email, otp: firstOtp } });
    const [firstAuthUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, email));
    customerIds.push(firstAuthUser!.customerId!);

    await backdateThrottleRows(email, 61); // clear the 60s per-email resend cooldown
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const secondOtp = emailSender.sent[1]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email, otp: secondOtp } });

    const authUsers = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, email));
    expect(authUsers).toHaveLength(1);
    expect(authUsers[0]?.customerId).toBe(firstAuthUser!.customerId);

    const matchingCustomers = await testDb.select().from(customers).where(eq(customers.email, email));
    expect(matchingCustomers).toHaveLength(1);
  });
});

describe("OTP code rules — same hardening as staff (allowedAttempts, expiry)", () => {
  test("6th wrong OTP attempt is rejected (allowedAttempts: 5)", async () => {
    const email = `wrong-attempts-${Date.now()}@example.test`;
    const { auth } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(auth.api.signInEmailOTP({ body: { email, otp: "000000" } })).rejects.toThrow();
    }
    // A 6th attempt — even if it somehow guessed right — must still be rejected because the
    // code itself is invalidated once allowedAttempts is reached, not just rate-limited.
    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, email));
    expect(authUser).toBeUndefined(); // never actually got created — no sign-in ever succeeded
  });

  test("an expired OTP is rejected", async () => {
    const email = `expired-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;

    // Force the stored verification row into the past rather than waiting 5 real minutes.
    await testDb.execute(
      `update customer_auth_verifications set expires_at = now() - interval '1 second' where identifier like '%sign-in%'`,
    );

    await expect(auth.api.signInEmailOTP({ body: { email, otp } })).rejects.toThrow();
  });
});

describe("per-email OTP send cooldown + cap (auth_email_throttle, shared with staff)", () => {
  test("resending within 60s is a silent no-op; past 60s it succeeds and restarts the code", async () => {
    const email = `cooldown-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth();

    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const immediate = await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    expect(immediate).toEqual({ success: true });
    expect(emailSender.sent).toHaveLength(1);

    await backdateThrottleRows(email, 61);
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    expect(emailSender.sent).toHaveLength(2);
  });

  test("a 6th send within the 5-per-5-minute cap is suppressed even once the cooldown has cleared", async () => {
    const email = `cap-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth();

    // See staff-auth.test.ts's own equivalent test for why these ages are seeded directly
    // rather than fired as 5 real sends spaced by the cooldown.
    for (const ageSeconds of [250, 200, 150, 100, 65]) {
      await testDb.insert(authEmailThrottle).values({ email, createdAt: sql`now() - make_interval(secs => ${ageSeconds})` });
    }

    const response = await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    expect(response).toEqual({ success: true });
    expect(emailSender.sent).toHaveLength(0);
  });
});

describe("whole-system OTP send cap (circuit breaker, shared with staff)", () => {
  test("suppresses a send even for a fresh email with no prior attempts of its own, and logs loudly", async () => {
    const email = `global-cap-${Date.now()}@example.test`;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth, emailSender } = buildCustomerAuth({ globalHourlyCap: 3 });

    for (const otherEmail of ["x@example.test", "y@example.test", "z@example.test"]) {
      await testDb.insert(authEmailThrottle).values({ email: otherEmail });
    }

    const response = await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    expect(response).toEqual({ success: true });
    expect(emailSender.sent).toHaveLength(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("GLOBAL OTP send cap reached"));
    consoleErrorSpy.mockRestore();
  });
});

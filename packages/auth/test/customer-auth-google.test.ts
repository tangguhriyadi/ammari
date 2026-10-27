import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { customerAuthAccounts, customerAuthUsers, customers } from "@ammari/db/schema";
import { buildCustomerAuth, cleanupCustomerAuthTables, cleanupCustomers, createCommittedCustomer, testDb } from "./customer-setup";

// Mirrors packages/auth/test/staff-auth-google.test.ts's own approach: stubs Google at the
// verifyIdToken/getUserInfo boundary Better Auth exposes for this purpose, so these tests make
// zero real network calls while still exercising the real `google` provider object and the real
// databaseHooks.user.create.before link-vs-create logic.

let customerIds: string[] = [];

beforeEach(() => {
  customerIds = [];
});

afterEach(async () => {
  await cleanupCustomerAuthTables();
  await cleanupCustomers(customerIds);
});

function stubGoogleProfile(email: string, emailVerified: boolean) {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: { email, emailVerified, name: "Test Customer" },
    data: {
      sub: `google-${email}`,
      email,
      email_verified: emailVerified,
      name: "Test Customer",
      given_name: "Test",
      family_name: "Customer",
      picture: "https://example.test/avatar.png",
      aud: "test-client-id",
      azp: "test-client-id",
      iss: "https://accounts.google.com",
      iat: now,
      exp: now + 3600,
    },
  };
}

describe("Google sign-in — customer self sign-up (link-vs-create hook)", () => {
  test("a brand-new verified Google email creates a new customers row and links it", async () => {
    const email = `google-new-${Date.now()}@example.test`;
    const { auth } = buildCustomerAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile(email, true),
      },
    });

    const result = await auth.api.signInSocial({ body: { provider: "google", idToken: { token: "stub-id-token" } } });
    if (!("user" in result)) throw new Error("expected an id-token sign-in response with a user");
    expect(result.user.email).toBe(email.toLowerCase());

    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, email));
    expect(authUser?.customerId).toBeTruthy();
    customerIds.push(authUser!.customerId!);

    const [customer] = await testDb.select().from(customers).where(eq(customers.id, authUser!.customerId!));
    expect(customer?.email).toBe(email.toLowerCase());
  });

  test("a verified Google email matching an existing customer links instead of duplicating", async () => {
    const existing = await createCommittedCustomer();
    customerIds.push(existing.id);
    const { auth } = buildCustomerAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile(existing.email!, true),
      },
    });

    const result = await auth.api.signInSocial({ body: { provider: "google", idToken: { token: "stub-id-token" } } });
    if (!("user" in result)) throw new Error("expected an id-token sign-in response with a user");

    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, existing.email!));
    expect(authUser?.customerId).toBe(existing.id);

    const matchingCustomers = await testDb.select().from(customers).where(eq(customers.email, existing.email!));
    expect(matchingCustomers).toHaveLength(1);
  });

  test("an UNVERIFIED Google email matching an existing customer is rejected, not linked", async () => {
    const existing = await createCommittedCustomer();
    customerIds.push(existing.id);
    const { auth } = buildCustomerAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile(existing.email!, false),
      },
    });

    await expect(
      auth.api.signInSocial({ body: { provider: "google", idToken: { token: "stub-id-token" } } }),
    ).rejects.toThrow();

    // Confirms this really was refused, not silently linked under a different code path.
    const authUsers = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, existing.email!));
    expect(authUsers).toHaveLength(0);
  });

  // docs/SPEC.md §10.3, same check and same generic error code as the staff path
  // (staff-auth-google.test.ts): Google has not verified this address, so the profile proves
  // nothing about who owns it.
  test("an UNVERIFIED brand-new Google email is refused: no account, no customers row", async () => {
    const email = `google-unverified-${Date.now()}@example.test`;
    const { auth } = buildCustomerAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile(email, false),
      },
    });

    await expect(auth.api.signInSocial({ body: { provider: "google", idToken: { token: "stub-id-token" } } })).rejects.toMatchObject({
      body: { code: "invalid_account" },
    });

    expect(await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, email))).toHaveLength(0);
    expect(await testDb.select().from(customers).where(eq(customers.email, email))).toHaveLength(0);
  });

  test("an UNVERIFIED Google email cannot sign in to or link the account an email code already made", async () => {
    const email = `google-otp-first-${Date.now()}@example.test`;
    const { auth, emailSender } = buildCustomerAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile(email, false),
      },
    });
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = emailSender.sent[0]!.body.match(/\d{6}/)?.[0]!;
    await auth.api.signInEmailOTP({ body: { email, otp } });
    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, email));
    customerIds.push(authUser!.customerId!);

    // Better Auth's own account linking refuses this before our validateUserInfo runs ("account
    // not linked": Google with an unverified email is not trusted for linking); the gate in
    // create-customer-auth.ts is the second line for the same case.
    await expect(auth.api.signInSocial({ body: { provider: "google", idToken: { token: "stub-id-token" } } })).rejects.toThrow();

    const accounts = await testDb.select().from(customerAuthAccounts).where(eq(customerAuthAccounts.userId, authUser!.id));
    expect(accounts.map((account) => account.providerId)).not.toContain("google");
  });
});

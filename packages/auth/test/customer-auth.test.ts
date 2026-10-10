import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { customerAuthUsers, customers } from "@ammari/db/schema";
import {
  buildCustomerAuth,
  cleanupCustomerAuthTables,
  cleanupCustomers,
  createCommittedCustomer,
  testDb,
} from "./customer-setup";

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

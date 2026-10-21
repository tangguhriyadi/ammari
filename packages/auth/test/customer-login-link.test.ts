import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLog, customerAuthSessions, customerAuthUsers, customerLoginLinks, customers } from "@ammari/db/schema";
import {
  LOGIN_LINK_MAX_PER_DAY,
  findLiveCustomerLoginLink,
  hashLoginLinkToken,
  issueOrReuseCustomerLoginLink,
  maskEmail,
} from "../src/customer";
import { buildCustomerAuth, cleanupCustomerAuthTables, cleanupCustomers, createCommittedCustomer, testDb } from "./customer-setup";

// "Masuk ke akun" login links (docs/plans/cart-checkout.md §9.3, session 14): issuance rules, the
// read-only lookup, and the login POST through Better Auth's real HTTP router (rate limiter and CSRF
// middleware included), against committed rows like the other customer auth tests.

const ORIGIN = "http://localhost:3000";
const CONSUME_URL = `${ORIGIN}/api/auth/order-login-link/consume`;

let customerIds: string[] = [];
let ipCounter = 0;

/** A fresh token per test, built at runtime. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A distinct client IP per test, so Better Auth's per-IP limiter never carries over. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

async function customer(email?: string) {
  const row = await createCommittedCustomer(email ? { email } : {});
  customerIds.push(row.id);
  return row;
}

async function issue(customerId: string, email: string, token = newToken()) {
  const result = await issueOrReuseCustomerLoginLink(testDb, { token, customerId, email, orderId: null, mayIssue: true });
  return { token, result };
}

function consumeRequest(token: string, init: { origin?: string | null; ip?: string; headers?: Record<string, string>; contentType?: string } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": init.contentType ?? "application/x-www-form-urlencoded",
    "cf-connecting-ip": init.ip ?? nextIp(),
    ...init.headers,
  };
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return new Request(CONSUME_URL, { method: "POST", headers, body: new URLSearchParams({ token }).toString() });
}

async function liveLink(customerId: string) {
  return testDb
    .select()
    .from(customerLoginLinks)
    .where(and(eq(customerLoginLinks.customerId, customerId), sql`${customerLoginLinks.consumedAt} is null and ${customerLoginLinks.supersededAt} is null`));
}

async function sessionCount(): Promise<number> {
  const [row] = await testDb.select({ n: sql<number>`count(*)::int` }).from(customerAuthSessions);
  return row?.n ?? 0;
}

beforeEach(() => {
  customerIds = [];
});

afterEach(async () => {
  if (customerIds.length > 0) {
    await testDb.delete(customerLoginLinks).where(inArray(customerLoginLinks.customerId, customerIds));
    await testDb.delete(auditLog).where(and(eq(auditLog.action, "customer_login_link"), inArray(auditLog.entityId, customerIds)));
  }
  await cleanupCustomerAuthTables();
  await cleanupCustomers(customerIds);
});

describe("issuing login links", () => {
  test("stores only the sha256 of the token, bound to the customer and email, valid 24 hours", async () => {
    const buyer = await customer();
    const { token, result } = await issue(buyer.id, buyer.email!);
    expect(result).toBe("issued");

    const rows = await testDb.select().from(customerLoginLinks).where(eq(customerLoginLinks.customerId, buyer.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashLoginLinkToken(token));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.email).toBe(buyer.email);
    const hours = (rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 3);
  });

  test("a second link supersedes the first, so one live link exists per customer", async () => {
    const buyer = await customer();
    const first = await issue(buyer.id, buyer.email!);
    const second = await issue(buyer.id, buyer.email!);
    expect(second.result).toBe("issued");

    const live = await liveLink(buyer.id);
    expect(live.map((row) => row.tokenHash)).toEqual([hashLoginLinkToken(second.token)]);
    expect(await findLiveCustomerLoginLink(testDb, first.token)).toBeNull();
    expect(await findLiveCustomerLoginLink(testDb, second.token)).toEqual({ customerId: buyer.id, maskedEmail: maskEmail(buyer.email!) });
  });

  test("the same token again is reused, and a retry never issues a new one", async () => {
    const buyer = await customer();
    const { token } = await issue(buyer.id, buyer.email!);
    expect(await issueOrReuseCustomerLoginLink(testDb, { token, customerId: buyer.id, email: buyer.email!, orderId: null, mayIssue: false })).toBe("existing");
    expect(await issueOrReuseCustomerLoginLink(testDb, { token: newToken(), customerId: buyer.id, email: buyer.email!, orderId: null, mayIssue: false })).toBe("not_issued");
    expect(await testDb.select().from(customerLoginLinks).where(eq(customerLoginLinks.customerId, buyer.id))).toHaveLength(1);
  });

  test("refuses an address that is not the customer's email", async () => {
    const buyer = await customer();
    const { result } = await issue(buyer.id, "someone-else@example.test");
    expect(result).toBe("email_mismatch");
    expect(await testDb.select().from(customerLoginLinks).where(eq(customerLoginLinks.customerId, buyer.id))).toHaveLength(0);
  });

  test(`issues at most ${LOGIN_LINK_MAX_PER_DAY} links per customer per 24 hours`, async () => {
    const buyer = await customer();
    for (let i = 0; i < LOGIN_LINK_MAX_PER_DAY; i += 1) expect((await issue(buyer.id, buyer.email!)).result).toBe("issued");
    expect((await issue(buyer.id, buyer.email!)).result).toBe("limited");

    // Older than 24 hours no longer counts.
    await testDb
      .update(customerLoginLinks)
      .set({ createdAt: sql`now() - interval '25 hours'`, expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(customerLoginLinks.customerId, buyer.id));
    expect((await issue(buyer.id, buyer.email!)).result).toBe("issued");
  });

  test("concurrent issuances for one customer leave exactly one live link", async () => {
    const buyer = await customer();
    const results = await Promise.all(Array.from({ length: 4 }, () => issue(buyer.id, buyer.email!)));
    expect(results.map((entry) => entry.result)).toEqual(["issued", "issued", "issued", "issued"]);
    expect(await liveLink(buyer.id)).toHaveLength(1);
  });

  test("the page lookup ignores malformed tokens and masks the email", async () => {
    expect(await findLiveCustomerLoginLink(testDb, "not-a-token")).toBeNull();
    expect(await findLiveCustomerLoginLink(testDb, undefined)).toBeNull();
    expect(maskEmail("aisyah@gmail.com")).toBe("a***@gmail.com");
  });
});

describe("logging in with a link (POST /api/auth/order-login-link/consume)", () => {
  test("logs in once: session cookie, verified email, audit row, consumed with the IP", async () => {
    const buyer = await customer();
    const { token } = await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();

    const response = await auth.handler(consumeRequest(token, { ip: "203.0.113.7" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/orders");
    expect(response.headers.get("set-cookie")).toContain("ammari_customer.session_token=");

    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.email, buyer.email!.toLowerCase()));
    expect(authUser?.customerId).toBe(buyer.id);
    expect(authUser?.emailVerified).toBe(true);
    expect(await sessionCount()).toBe(1);
    const [row] = await testDb.select().from(customers).where(eq(customers.id, buyer.id));
    expect(row?.emailVerifiedAt).toBeTruthy();

    const [link] = await testDb.select().from(customerLoginLinks).where(eq(customerLoginLinks.customerId, buyer.id));
    expect(link?.consumedAt).toBeTruthy();
    expect(link?.consumedIp).toBe("203.0.113.7");
    const audits = await testDb.select().from(auditLog).where(and(eq(auditLog.action, "customer_login_link"), eq(auditLog.entityId, buyer.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorStaffUserId).toBeNull();
    expect(audits[0]!.after).toEqual({ linkId: link!.id, orderId: null, ip: "203.0.113.7" });
    expect(JSON.stringify(audits[0])).not.toContain(token);

    // Used twice: the generic "no longer valid" answer, no second session.
    const again = await auth.handler(consumeRequest(token));
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe("/login/link?status=invalid");
    expect(again.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await sessionCount()).toBe(1);
  });

  test("a failure before the session exists gives the link back; it then logs in", async () => {
    const buyer = await customer();
    const { token } = await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();
    const context = await auth.$context;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const createSession = vi.spyOn(context.internalAdapter, "createSession").mockRejectedValueOnce(Object.assign(new Error("connection lost"), { code: "08006" }));

    const failed = await auth.handler(consumeRequest(token));
    expect(failed.headers.get("location")).toBe("/login/link?status=error");
    expect(errors).toHaveBeenCalledWith("[order-login-link] login link failed", expect.objectContaining({ stage: "before_session", linkReleased: true, code: "08006" }));
    expect(await findLiveCustomerLoginLink(testDb, token)).not.toBeNull();

    const retried = await auth.handler(consumeRequest(token));
    expect(retried.headers.get("location")).toBe("/orders");
    expect(await sessionCount()).toBe(1);
    createSession.mockRestore();
    errors.mockRestore();
  });

  test("logs into an existing account of the same customer", async () => {
    const buyer = await customer();
    await testDb.insert(customerAuthUsers).values({ name: "Pembeli", email: buyer.email!.toLowerCase(), emailVerified: false, customerId: buyer.id });
    const { token } = await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();

    const response = await auth.handler(consumeRequest(token));
    expect(response.headers.get("location")).toBe("/orders");
    const [authUser] = await testDb.select().from(customerAuthUsers).where(eq(customerAuthUsers.customerId, buyer.id));
    expect(authUser?.emailVerified).toBe(true);
    expect(await sessionCount()).toBe(1);
  });

  test("an account for the email that belongs to another customer is refused", async () => {
    const buyer = await customer();
    const other = await customer();
    await testDb.insert(customerAuthUsers).values({ name: "Lain", email: buyer.email!.toLowerCase(), emailVerified: true, customerId: other.id });
    const { token } = await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();

    const response = await auth.handler(consumeRequest(token));
    expect(response.headers.get("location")).toBe("/login/link?status=invalid");
    expect(await sessionCount()).toBe(0);
  });

  test("superseded, expired and malformed links do not log in", async () => {
    const buyer = await customer();
    const first = await issue(buyer.id, buyer.email!);
    await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();

    expect((await auth.handler(consumeRequest(first.token))).headers.get("location")).toBe("/login/link?status=invalid");

    const expiring = await customer();
    const expired = await issue(expiring.id, expiring.email!);
    await testDb
      .update(customerLoginLinks)
      .set({ createdAt: sql`now() - interval '25 hours'`, expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(customerLoginLinks.customerId, expiring.id));
    expect((await auth.handler(consumeRequest(expired.token))).headers.get("location")).toBe("/login/link?status=invalid");

    expect((await auth.handler(consumeRequest("abc"))).headers.get("location")).toBe("/login/link?status=invalid");
    expect(await sessionCount()).toBe(0);
  });

  test("a customer whose email changed after the link was sent is not logged in", async () => {
    const buyer = await customer();
    const { token } = await issue(buyer.id, buyer.email!);
    await testDb.update(customers).set({ email: `changed-${buyer.id}@example.test` }).where(eq(customers.id, buyer.id));
    const { auth } = buildCustomerAuth();

    expect((await auth.handler(consumeRequest(token))).headers.get("location")).toBe("/login/link?status=invalid");
    expect(await findLiveCustomerLoginLink(testDb, token)).toBeNull();
    expect(await sessionCount()).toBe(0);
  });

  test("CSRF: a missing, null or foreign Origin and a cross-site navigation are refused and leave the link usable", async () => {
    const buyer = await customer();
    const { token } = await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();

    for (const request of [
      consumeRequest(token, { origin: null }),
      consumeRequest(token, { origin: "null" }),
      consumeRequest(token, { origin: "https://evil.example" }),
      consumeRequest(token, { origin: null, headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }),
      consumeRequest(token, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }),
    ]) {
      const response = await auth.handler(request);
      expect(response.status).toBe(403);
    }
    expect(await sessionCount()).toBe(0);
    expect(await findLiveCustomerLoginLink(testDb, token)).not.toBeNull();
  });

  test("only a form post is accepted, and GET never logs in", async () => {
    const buyer = await customer();
    const { token } = await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();

    const json = await auth.handler(
      new Request(CONSUME_URL, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": nextIp() }, body: JSON.stringify({ token }) }),
    );
    expect(json.status).toBe(415);
    const get = await auth.handler(new Request(`${CONSUME_URL}?token=${token}`, { headers: { "cf-connecting-ip": nextIp() } }));
    expect(get.status).toBe(404);
    expect(await sessionCount()).toBe(0);
    expect(await findLiveCustomerLoginLink(testDb, token)).not.toBeNull();
  });

  test("the server-side API cannot log in without a request", async () => {
    const buyer = await customer();
    const { token } = await issue(buyer.id, buyer.email!);
    const { auth } = buildCustomerAuth();
    const api = auth.api as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await expect(api.consumeOrderLoginLink!({ body: { token } })).rejects.toThrow();
    expect(await findLiveCustomerLoginLink(testDb, token)).not.toBeNull();
  });

  test("10 attempts per 10 minutes per IP", async () => {
    const { auth } = buildCustomerAuth();
    const ip = "192.0.2.77";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await auth.handler(consumeRequest(newToken(), { ip }))).status);
    expect(statuses.slice(0, 10).every((status) => status === 302)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Another IP is not affected.
    expect((await auth.handler(consumeRequest(newToken(), { ip: "192.0.2.78" }))).status).toBe(302);
  });
});

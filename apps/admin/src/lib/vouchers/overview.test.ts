import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder, insertThankYouCard } from "@ammari/db/test-fixtures";
import { vouchers, type VoucherStatus } from "@ammari/db/schema";
import { effectiveVoucherStatus } from "./status";
import { effectiveVoucherStatusSql } from "./status-sql";
import { getVoucherPeriodStats, getVoucherStatusCounts, listExpiringSoonVouchers, listVouchers, ratePercent } from "./overview";

// docs/plans/growth.md §9.1, §9.2 (session S5). Period figures use a month in 2004 that no other
// fixture touches; status counts are compared as deltas inside the test's own transaction.

const DAY = 86_400_000;

async function voucherFor(db: TestDatabase, customerId: string, overrides: Partial<typeof vouchers.$inferInsert> = {}) {
  const order = await insertOrder(db, { customerId });
  const card = await insertThankYouCard(db, order.id, { status: "claimed", claimedByCustomerId: customerId, claimedAt: new Date() });
  const [row] = await db.insert(vouchers).values({ cardId: card.id, customerId, expiresAt: new Date(Date.now() + 30 * DAY), ...overrides }).returning();
  return row!;
}

async function fixtures(db: TestDatabase, name: string) {
  const customer = await insertCustomer(db, { name });
  const usedOrder = await insertOrder(db, { customerId: customer.id });
  const past = { issuedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - DAY) };
  return {
    customer,
    active: await voucherFor(db, customer.id, { amount: 25_000 }),
    soon: await voucherFor(db, customer.id, { expiresAt: new Date(Date.now() + 5 * DAY) }),
    lapsed: await voucherFor(db, customer.id, past),
    storedExpired: await voucherFor(db, customer.id, { ...past, status: "expired" }),
    used: await voucherFor(db, customer.id, { status: "used", usedOrderId: usedOrder.id, usedAt: new Date() }),
    voided: await voucherFor(db, customer.id, { status: "void" }),
  };
}

describe("effective status in SQL", () => {
  test("agrees with effectiveVoucherStatus for every branch", async () => {
    await withRollback(async (tx) => {
      const set = await fixtures(tx, `Twin ${randomUUID()}`);
      const rows = await tx.execute<{ id: string; status: VoucherStatus; stored: VoucherStatus; expires_at: string }>(
        sql`select v.id, ${effectiveVoucherStatusSql()} as status, v.status as stored, v.expires_at from ${vouchers} v where v.customer_id = ${set.customer.id}`,
      );
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(row.status).toBe(effectiveVoucherStatus({ status: row.stored, expiresAt: new Date(row.expires_at) }).status);
      expect(rows.filter((row) => row.status === "expired")).toHaveLength(2);
    });
  });
});

describe("getVoucherStatusCounts", () => {
  test("counts effective statuses; the active value only for finance", async () => {
    await withRollback(async (tx) => {
      const before = await getVoucherStatusCounts({ canViewProfit: true }, tx);
      await fixtures(tx, `Counts ${randomUUID()}`);
      const after = await getVoucherStatusCounts({ canViewProfit: true }, tx);
      expect({
        active: after.active - before.active,
        expiringSoon: after.expiringSoon - before.expiringSoon,
        used: after.used - before.used,
        expired: after.expired - before.expired,
        void: after.void - before.void,
        activeValue: after.activeValue! - before.activeValue!,
      }).toEqual({ active: 2, expiringSoon: 1, used: 1, expired: 2, void: 1, activeValue: 45_000 });
      expect((await getVoucherStatusCounts({ canViewProfit: false }, tx)).activeValue).toBeNull();
    });
  });
});

describe("lists", () => {
  test("Segera berakhir lists only usable vouchers within 14 days, with the customer name", async () => {
    await withRollback(async (tx) => {
      const name = `Soon ${randomUUID()}`;
      const set = await fixtures(tx, name);
      const rows = (await listExpiringSoonVouchers(500, tx)).filter((row) => row.customerId === set.customer.id);
      expect(rows).toMatchObject([{ id: set.soon.id, customerName: name, status: "active", expiringSoon: true }]);
      expect(Object.keys(rows[0]!)).not.toContain("email");
    });
  });

  test("filter tabs use the effective status; search by customer name", async () => {
    await withRollback(async (tx) => {
      const name = `List ${randomUUID()}`;
      const set = await fixtures(tx, name);
      const ids = async (status?: Parameters<typeof listVouchers>[0]["status"]) => (await listVouchers({ status, q: name }, undefined, undefined, tx)).rows.map((row) => row.id).sort();
      expect(await ids()).toHaveLength(6);
      expect(await ids("active")).toEqual([set.active.id, set.soon.id].sort());
      expect(await ids("expiring")).toEqual([set.soon.id]);
      expect(await ids("expired")).toEqual([set.lapsed.id, set.storedExpired.id].sort());
      expect(await ids("used")).toEqual([set.used.id]);
      expect(await ids("void")).toEqual([set.voided.id]);
      const used = (await listVouchers({ status: "used", q: name }, undefined, undefined, tx)).rows[0];
      expect(used?.usedOrder?.orderNo).toMatch(/^ORD-TEST-/);
    });
  });
});

describe("getVoucherPeriodStats", () => {
  test("claim and redemption rates leave out what is still open", async () => {
    await withRollback(async (tx) => {
      const month = { start: new Date("2004-03-01T00:00:00+07:00"), end: new Date("2004-04-01T00:00:00+07:00") };
      const inMonth = new Date("2004-03-10T03:00:00Z");
      const customer = await insertCustomer(tx);
      const card = async (overrides: Parameters<typeof insertThankYouCard>[2]) => insertThankYouCard(tx, (await insertOrder(tx)).id, { createdAt: inMonth, ...overrides });
      // Printed in March 2004: two claimed, one unclaimed past its deadline, one still claimable,
      // one voided (cancelled order), and a reprinted order (below). Claim rate = 2 of 4 closed.
      const claimedA = await card({ status: "claimed", claimedByCustomerId: customer.id, claimedAt: inMonth, claimDeadline: new Date("2004-04-10T00:00:00Z") });
      const claimedB = await card({ status: "claimed", claimedByCustomerId: customer.id, claimedAt: new Date("2004-04-02T03:00:00Z"), claimDeadline: new Date("2004-04-10T00:00:00Z") });
      await card({ claimDeadline: new Date("2004-04-10T00:00:00Z") });
      await card({ claimDeadline: new Date(Date.now() + 10 * DAY) });
      await card({ status: "void", claimDeadline: new Date("2004-04-10T00:00:00Z") });
      // A reprint of the same order: one printed order, not two.
      const reprinted = await insertOrder(tx);
      await insertThankYouCard(tx, reprinted.id, { status: "void", createdAt: inMonth, claimDeadline: new Date("2004-04-10T00:00:00Z") });
      await insertThankYouCard(tx, reprinted.id, { createdAt: new Date("2004-03-11T03:00:00Z"), claimDeadline: new Date("2004-04-11T00:00:00Z") });

      // Vouchers issued in March 2004: used, expired, void; plus one issued then but extended so it
      // is still active (open). Redemption = 1 of 2.
      const usedOrder = await insertOrder(tx, { customerId: customer.id });
      const issued = { issuedAt: inMonth, expiresAt: new Date("2004-06-10T00:00:00Z") };
      await tx.insert(vouchers).values([
        { cardId: claimedA.id, customerId: customer.id, ...issued, status: "used", usedOrderId: usedOrder.id, usedAt: new Date("2004-03-20T03:00:00Z") },
        { cardId: claimedB.id, customerId: customer.id, ...issued },
        { cardId: (await card({ status: "claimed", claimedByCustomerId: customer.id, claimedAt: new Date("2004-02-10T03:00:00Z"), createdAt: new Date("2004-02-01T03:00:00Z") })).id, customerId: customer.id, ...issued, status: "void" },
        { cardId: (await card({ status: "claimed", claimedByCustomerId: customer.id, claimedAt: new Date("2004-02-11T03:00:00Z"), createdAt: new Date("2004-02-01T03:00:00Z") })).id, customerId: customer.id, issuedAt: inMonth, expiresAt: new Date(Date.now() + 30 * DAY) },
      ]);

      const stats = await getVoucherPeriodStats(month, tx);
      expect(stats).toEqual({
        cardsPrinted: 6,
        cardsClaimed: 1,
        vouchersUsed: 1,
        claimRate: { part: 2, whole: 4 },
        redemptionRate: { part: 1, whole: 2 },
      });
      expect(ratePercent(stats.claimRate)).toBe(50);
      expect(ratePercent({ part: 0, whole: 0 })).toBeNull();
    });
  });
});

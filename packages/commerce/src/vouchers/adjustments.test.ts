import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import { auditLog, voucherAdjustments, vouchers } from "@ammari/db/schema";
import { ActionError, FieldError } from "../errors";
import { jakartaDate } from "../jakarta-day";
import {
  VOUCHER_ADJUSTMENT_MESSAGES,
  endOfJakartaDay,
  extendVoucher,
  latestExtensionDate,
  resolveExtensionExpiry,
  voidVoucher,
} from "./adjustments";

// docs/plans/growth.md §9.3 (session S5). The races with checkout's redemption run against real
// commits in checkout/place-order.test.ts ("placeOrder races").

const DAY = 86_400_000;

async function voucher(db: TestDatabase, overrides: Partial<typeof vouchers.$inferInsert> = {}) {
  const customer = await insertCustomer(db);
  const order = await insertOrder(db);
  const card = await insertThankYouCard(db, order.id, { status: "claimed", claimedByCustomerId: customer.id, claimedAt: new Date() });
  const [row] = await db
    .insert(vouchers)
    .values({ cardId: card.id, customerId: customer.id, amount: 20_000, expiresAt: new Date(Date.now() + 30 * DAY), ...overrides })
    .returning();
  if (!row) throw new Error("voucher fixture");
  return row;
}

function plusDays(days: number): string {
  return jakartaDate(new Date(Date.now() + days * DAY));
}

describe("pure date rules", () => {
  test("the end of a Jakarta day is 23:59:59 WIB", () => {
    expect(endOfJakartaDay("2026-11-30").toISOString()).toBe("2026-11-30T16:59:59.000Z");
  });

  test("at most three calendar months ahead, clamped to the target month's last day", () => {
    expect(latestExtensionDate("2026-10-27")).toBe("2027-01-27");
    expect(latestExtensionDate("2026-11-30")).toBe("2027-02-28");
    expect(latestExtensionDate("2027-11-30")).toBe("2028-02-29");
    expect(latestExtensionDate("2026-12-31")).toBe("2027-03-31");
  });

  test("the new expiry must be a real date after today and after the current expiry", () => {
    const now = new Date("2026-10-27T05:00:00Z"); // 12:00 WIB
    expect(() => resolveExtensionExpiry("2026-02-30", null, now)).toThrow(VOUCHER_ADJUSTMENT_MESSAGES.invalidDate);
    // Today is not "after now" as a whole day: the voucher would lapse in hours.
    expect(() => resolveExtensionExpiry("2026-10-27", null, now)).toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notInFuture);
    expect(() => resolveExtensionExpiry("2026-10-01", null, now)).toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notInFuture);
    expect(() => resolveExtensionExpiry("2027-01-28", null, now)).toThrow(VOUCHER_ADJUSTMENT_MESSAGES.tooFar);
    expect(resolveExtensionExpiry("2027-01-27", null, now).toISOString()).toBe("2027-01-27T16:59:59.000Z");
    expect(() => resolveExtensionExpiry("2026-11-10", new Date("2026-11-10T16:59:59Z"), now)).toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notAfterCurrent);
    try {
      resolveExtensionExpiry("2026-10-28", new Date("2026-12-01T00:00:00Z"), now);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe("newExpiryDate");
    }
  });
});

describe("voidVoucher", () => {
  test("an active voucher becomes void, with its history row and audit entry", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await voucher(tx);
      const { voucher: voided, adjustment } = await voidVoucher({ voucherId: row.id, reason: "  Kartu hilang dilaporkan  ", actorStaffUserId: staff.id }, tx);
      expect(voided.status).toBe("void");
      expect(voided.expiresAt).toEqual(row.expiresAt);
      expect(adjustment).toMatchObject({ voucherId: row.id, kind: "void", previousStatus: "active", previousExpiresAt: row.expiresAt, newExpiresAt: null, reason: "Kartu hilang dilaporkan", staffUserId: staff.id });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.entityType, "voucher")));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "void", actorStaffUserId: staff.id, before: { status: "active" }, after: { voucher: { status: "void" } } });
    });
  });

  test("used, expired (stored or by date) and void vouchers are refused, and nothing is written", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const usedOrder = await insertOrder(tx);
      const refusals = [
        await voucher(tx, { status: "used", usedOrderId: usedOrder.id, usedAt: new Date() }),
        await voucher(tx, { issuedAt: new Date(Date.now() - 60 * DAY), expiresAt: new Date(Date.now() - DAY) }),
        await voucher(tx, { status: "expired", issuedAt: new Date(Date.now() - 60 * DAY), expiresAt: new Date(Date.now() - DAY) }),
        await voucher(tx, { status: "void" }),
      ];
      for (const row of refusals) {
        await expect(voidVoucher({ voucherId: row.id, reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notVoidable);
        expect(await tx.select().from(voucherAdjustments).where(eq(voucherAdjustments.voucherId, row.id))).toHaveLength(0);
        expect(await tx.select().from(auditLog).where(eq(auditLog.entityId, row.id))).toHaveLength(0);
        const [after] = await tx.select().from(vouchers).where(eq(vouchers.id, row.id));
        expect(after?.status).toBe(row.status);
      }
    });
  });

  test("a reason is required, and an unknown or malformed id is 'not found'", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await voucher(tx);
      await expect(voidVoucher({ voucherId: row.id, reason: "   ", actorStaffUserId: staff.id }, tx)).rejects.toThrow(FieldError);
      await expect(voidVoucher({ voucherId: row.id, reason: "x".repeat(501), actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.reasonTooLong);
      await expect(voidVoucher({ voucherId: "00000000-0000-0000-0000-000000000000", reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(ActionError);
      await expect(voidVoucher({ voucherId: "bukan-id", reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notFound);
    });
  });
});

describe("extendVoucher", () => {
  test("an expired voucher (active past its date) becomes active with the new end of day", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await voucher(tx, { issuedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - 2 * DAY) });
      const target = plusDays(30);
      const { voucher: extended, adjustment } = await extendVoucher({ voucherId: row.id, newExpiryDate: target, reason: "Pelanggan sakit", actorStaffUserId: staff.id }, tx);
      expect(extended.status).toBe("active");
      expect(extended.expiresAt).toEqual(endOfJakartaDay(target));
      expect(adjustment).toMatchObject({ kind: "extend", previousStatus: "active", previousExpiresAt: row.expiresAt, newExpiresAt: endOfJakartaDay(target), reason: "Pelanggan sakit" });
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "extend")));
      expect(audit).toMatchObject({ entityType: "voucher", actorStaffUserId: staff.id });
    });
  });

  test("a stored 'expired' voucher (restored after a cancelled order) is extended back to active", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await voucher(tx, { status: "expired", issuedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - DAY) });
      const { voucher: extended, adjustment } = await extendVoucher({ voucherId: row.id, newExpiryDate: plusDays(10), reason: "Pesanan dibatalkan toko", actorStaffUserId: staff.id }, tx);
      expect(extended.status).toBe("active");
      expect(adjustment.previousStatus).toBe("expired");
    });
  });

  test("an active voucher can be pushed later, never earlier or to its own date", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await voucher(tx, { expiresAt: endOfJakartaDay(plusDays(40)) });
      await expect(extendVoucher({ voucherId: row.id, newExpiryDate: plusDays(40), reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notAfterCurrent);
      await expect(extendVoucher({ voucherId: row.id, newExpiryDate: plusDays(20), reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notAfterCurrent);
      const { voucher: extended } = await extendVoucher({ voucherId: row.id, newExpiryDate: plusDays(50), reason: "Tes", actorStaffUserId: staff.id }, tx);
      expect(extended.expiresAt).toEqual(endOfJakartaDay(plusDays(50)));
      expect(await tx.select().from(voucherAdjustments).where(eq(voucherAdjustments.voucherId, row.id))).toHaveLength(1);
    });
  });

  test("today, a past date, or more than three months ahead are refused before any write", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await voucher(tx, { issuedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - DAY) });
      const today = jakartaDate();
      await expect(extendVoucher({ voucherId: row.id, newExpiryDate: today, reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notInFuture);
      await expect(extendVoucher({ voucherId: row.id, newExpiryDate: plusDays(-3), reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notInFuture);
      const tooFar = jakartaDate(new Date(endOfJakartaDay(latestExtensionDate(today)).getTime() + DAY));
      await expect(extendVoucher({ voucherId: row.id, newExpiryDate: tooFar, reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.tooFar);
      await extendVoucher({ voucherId: row.id, newExpiryDate: latestExtensionDate(today), reason: "Tes", actorStaffUserId: staff.id }, tx);
    });
  });

  test("used and void vouchers are refused", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const usedOrder = await insertOrder(tx);
      const used = await voucher(tx, { status: "used", usedOrderId: usedOrder.id, usedAt: new Date() });
      const voided = await voucher(tx, { status: "void" });
      for (const row of [used, voided]) {
        await expect(extendVoucher({ voucherId: row.id, newExpiryDate: plusDays(60), reason: "Tes", actorStaffUserId: staff.id }, tx)).rejects.toThrow(VOUCHER_ADJUSTMENT_MESSAGES.notExtendable);
        expect(await tx.select().from(voucherAdjustments).where(eq(voucherAdjustments.voucherId, row.id))).toHaveLength(0);
      }
    });
  });
});

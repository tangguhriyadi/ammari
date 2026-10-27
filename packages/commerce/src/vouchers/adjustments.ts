import "server-only";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { voucherAdjustments, vouchers, type VoucherStatus } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "../db";
import { ActionError, FieldError } from "../errors";
import { isCalendarDate, jakartaDate } from "../jakarta-day";

// Owner void and extension of a thank-you-card voucher (docs/plans/growth.md §9.3, owner answer
// A8). Both race checkout's redemption (checkout/place-order.ts: one conditional UPDATE on
// `status = 'active' and expires_at > now()`), so each is ONE conditional UPDATE on the voucher
// row; whichever commits first wins and the other gets zero rows. The voucher row is locked first
// (SELECT ... FOR UPDATE) only so the history row and the audit entry record exactly the state
// the UPDATE changed; the UPDATE's own WHERE is what decides. The adjustment row and the audit
// entry are written only after the UPDATE returned a row, in the same transaction.

export const MAX_ADJUSTMENT_REASON_LENGTH = 500;
/** "At most 3 months from today" (A8). */
export const MAX_EXTENSION_MONTHS = 3;

export const VOUCHER_ADJUSTMENT_MESSAGES = {
  notFound: "Voucher tidak ditemukan.",
  reasonRequired: "Alasan wajib diisi.",
  reasonTooLong: `Alasan maksimal ${MAX_ADJUSTMENT_REASON_LENGTH} karakter.`,
  notVoidable: "Voucher sudah dipakai atau tidak aktif lagi.",
  notExtendable: "Voucher yang sudah dipakai atau dibatalkan tidak bisa diperpanjang.",
  invalidDate: "Tanggal berlaku baru tidak valid.",
  notInFuture: "Tanggal berlaku baru harus setelah hari ini.",
  notAfterCurrent: "Tanggal berlaku baru harus setelah tanggal berlaku sekarang.",
  tooFar: `Perpanjangan maksimal ${MAX_EXTENSION_MONTHS} bulan dari hari ini.`,
} as const;

export function normalizeAdjustmentReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", VOUCHER_ADJUSTMENT_MESSAGES.reasonRequired);
  if (trimmed.length > MAX_ADJUSTMENT_REASON_LENGTH) throw new FieldError("reason", VOUCHER_ADJUSTMENT_MESSAGES.reasonTooLong);
  return trimmed;
}

/** 23:59:59 WIB of a Jakarta calendar date: the same end-of-day convention as a claimed voucher's
 * own expiry (apps/web lib/claim/dates.ts). */
export function endOfJakartaDay(date: string): Date {
  return new Date(`${date}T23:59:59+07:00`);
}

/** `today` + MAX_EXTENSION_MONTHS calendar months, clamped to the last day of the target month
 * (30 Nov + 3 months = 28/29 Feb), as voucherExpiresAt clamps. */
export function latestExtensionDate(today: string): string {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const targetIndex = month - 1 + MAX_EXTENSION_MONTHS;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = (targetIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** The new expiry for an extension, or a FieldError naming `newExpiryDate`. "After the current
 * expiry" is checked again by the UPDATE's own WHERE (and the adjustment CHECK); "after now" is
 * app-only, since a CHECK cannot use now() (plan §9.3). */
export function resolveExtensionExpiry(newExpiryDate: string, currentExpiresAt: Date | null, now: Date = new Date()): Date {
  if (!isCalendarDate(newExpiryDate)) throw new FieldError("newExpiryDate", VOUCHER_ADJUSTMENT_MESSAGES.invalidDate);
  const today = jakartaDate(now);
  if (newExpiryDate <= today) throw new FieldError("newExpiryDate", VOUCHER_ADJUSTMENT_MESSAGES.notInFuture);
  if (newExpiryDate > latestExtensionDate(today)) throw new FieldError("newExpiryDate", VOUCHER_ADJUSTMENT_MESSAGES.tooFar);
  const expiresAt = endOfJakartaDay(newExpiryDate);
  if (currentExpiresAt !== null && expiresAt.getTime() <= currentExpiresAt.getTime()) {
    throw new FieldError("newExpiryDate", VOUCHER_ADJUSTMENT_MESSAGES.notAfterCurrent);
  }
  return expiresAt;
}

async function lockVoucher(tx: Database, voucherId: string) {
  const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId)).for("update");
  if (!voucher) throw new ActionError(VOUCHER_ADJUSTMENT_MESSAGES.notFound);
  return voucher;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertVoucherId(voucherId: string): void {
  if (!UUID_PATTERN.test(voucherId)) throw new ActionError(VOUCHER_ADJUSTMENT_MESSAGES.notFound);
}

/** "Batalkan voucher": only an effective-active voucher (stored active, not yet expired). A used
 * voucher cannot be voided (cancel the order instead); an expired one needs no void. */
export async function voidVoucher(
  input: { voucherId: string; reason: string; actorStaffUserId: string },
  db: Database = defaultDb,
) {
  assertVoucherId(input.voucherId);
  const reason = normalizeAdjustmentReason(input.reason);

  return db.transaction(async (tx) => {
    const before = await lockVoucher(tx, input.voucherId);
    const [row] = await tx
      .update(vouchers)
      .set({ status: "void" })
      .where(and(eq(vouchers.id, input.voucherId), eq(vouchers.status, "active"), sql`${vouchers.expiresAt} > now()`))
      .returning();
    if (!row) throw new ActionError(VOUCHER_ADJUSTMENT_MESSAGES.notVoidable);

    const [adjustment] = await tx
      .insert(voucherAdjustments)
      .values({
        voucherId: row.id,
        kind: "void",
        previousStatus: before.status as VoucherStatus,
        previousExpiresAt: before.expiresAt,
        newExpiresAt: null,
        reason,
        staffUserId: input.actorStaffUserId,
      })
      .returning();
    if (!adjustment) throw new Error("failed to insert voucher adjustment");
    await writeAuditLog(tx, { actorStaffUserId: input.actorStaffUserId, action: "void", entityType: "voucher", entityId: row.id, before, after: { voucher: row, adjustment } });
    return { voucher: row, adjustment };
  });
}

/** "Perpanjang voucher": an effective-active or expired voucher, never a used or void one. The new
 * expiry is the end of `newExpiryDate` (Jakarta), after both now and the current expiry, at most
 * 3 months from today. An expired voucher becomes active again. */
export async function extendVoucher(
  input: { voucherId: string; newExpiryDate: string; reason: string; actorStaffUserId: string },
  db: Database = defaultDb,
  now: Date = new Date(),
) {
  assertVoucherId(input.voucherId);
  const reason = normalizeAdjustmentReason(input.reason);
  // Date rules that need no row first, so a bad date is a field error before any lock.
  resolveExtensionExpiry(input.newExpiryDate, null, now);

  return db.transaction(async (tx) => {
    const before = await lockVoucher(tx, input.voucherId);
    if (before.status === "used" || before.status === "void" || before.usedOrderId !== null) {
      throw new ActionError(VOUCHER_ADJUSTMENT_MESSAGES.notExtendable);
    }
    const newExpiresAt = resolveExtensionExpiry(input.newExpiryDate, before.expiresAt, now);
    const [row] = await tx
      .update(vouchers)
      .set({ expiresAt: newExpiresAt, status: "active" })
      .where(
        and(
          eq(vouchers.id, input.voucherId),
          inArray(vouchers.status, ["active", "expired"]),
          isNull(vouchers.usedOrderId),
          lt(vouchers.expiresAt, newExpiresAt),
        ),
      )
      .returning();
    if (!row) throw new ActionError(VOUCHER_ADJUSTMENT_MESSAGES.notExtendable);

    const [adjustment] = await tx
      .insert(voucherAdjustments)
      .values({
        voucherId: row.id,
        kind: "extend",
        previousStatus: before.status as VoucherStatus,
        previousExpiresAt: before.expiresAt,
        newExpiresAt,
        reason,
        staffUserId: input.actorStaffUserId,
      })
      .returning();
    if (!adjustment) throw new Error("failed to insert voucher adjustment");
    await writeAuditLog(tx, { actorStaffUserId: input.actorStaffUserId, action: "extend", entityType: "voucher", entityId: row.id, before, after: { voucher: row, adjustment } });
    return { voucher: row, adjustment };
  });
}

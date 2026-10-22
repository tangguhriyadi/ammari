import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { vouchers } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";

/** How recent a claim still counts as "just claimed" for the homepage notice. Generous enough
 * for a slow redirect, short enough that an old voucher's dates never show as if new. */
const JUST_CLAIMED_WINDOW_MS = 15 * 60_000;

/** The expiry of the voucher this customer claimed in the last few minutes (the newest, if
 * several), or null. Keyed only by the session's own customer id, never by anything in the URL. */
export async function findJustClaimedVoucherExpiry(customerId: string, db: Database = defaultDb, now: Date = new Date()): Promise<Date | null> {
  const [row] = await db
    .select({ expiresAt: vouchers.expiresAt })
    .from(vouchers)
    .where(and(eq(vouchers.customerId, customerId), eq(vouchers.status, "active"), gte(vouchers.issuedAt, new Date(now.getTime() - JUST_CLAIMED_WINDOW_MS))))
    .orderBy(desc(vouchers.issuedAt))
    .limit(1);
  return row?.expiresAt ?? null;
}

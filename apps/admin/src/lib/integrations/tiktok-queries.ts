import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { getTikTokConnectionView, listUnmappedTikTokSkus, type TikTokConnectionView } from "@ammari/commerce/tiktok";
import { staffUsers, tiktokOrders, tiktokSyncCursors, tiktokWebhookEvents } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";

// Reads for the Integrasi TikTok Shop page and the home banner. No token column is ever selected
// (getTikTokConnectionView picks its columns).

export interface TikTokIntegrationPageData {
  connection: TikTokConnectionView | null;
  connectedByName: string | null;
  webhookCounts: { pending: number; failed: number };
  /** The order poll's cursor (T4): everything below `windowEnd` is stored. */
  ordersCursor: { windowEnd: Date | null; lastRunAt: Date | null; lastOkAt: Date | null; lastErrorCode: string | null } | null;
  /** The latest inbox events that gave up after 10 attempts (codes only). */
  failedEvents: { id: string; type: number; receivedAt: Date; attempts: number; lastErrorCode: string | null }[];
  tiktokOrderCount: number;
  unmappedSkuCount: number;
  /** T5: TikTok orders applied to admin, and held (with why). */
  appliedCount: number;
  heldByReason: { reason: string; count: number }[];
}

export const FAILED_EVENTS_SHOWN = 10;

export async function getTikTokIntegrationPageData(db: Database = defaultDb): Promise<TikTokIntegrationPageData> {
  const [connection, [counts]] = await Promise.all([
    getTikTokConnectionView(db),
    db
      .select({
        pending: sql<number>`count(*) filter (where ${tiktokWebhookEvents.status} = 'pending')::int`,
        failed: sql<number>`count(*) filter (where ${tiktokWebhookEvents.status} = 'failed')::int`,
      })
      .from(tiktokWebhookEvents),
  ]);
  let connectedByName: string | null = null;
  if (connection?.connectedByStaffUserId) {
    const [staff] = await db.select({ name: staffUsers.name }).from(staffUsers).where(eq(staffUsers.id, connection.connectedByStaffUserId));
    connectedByName = staff?.name ?? null;
  }
  const [[cursor], failedEvents, [orderCount], unmapped] = await Promise.all([
    db
      .select({ windowEnd: tiktokSyncCursors.windowEnd, lastRunAt: tiktokSyncCursors.lastRunAt, lastOkAt: tiktokSyncCursors.lastOkAt, lastErrorCode: tiktokSyncCursors.lastErrorCode })
      .from(tiktokSyncCursors)
      .where(eq(tiktokSyncCursors.resource, "orders")),
    db
      .select({ id: tiktokWebhookEvents.id, type: tiktokWebhookEvents.type, receivedAt: tiktokWebhookEvents.receivedAt, attempts: tiktokWebhookEvents.attempts, lastErrorCode: tiktokWebhookEvents.lastErrorCode })
      .from(tiktokWebhookEvents)
      .where(eq(tiktokWebhookEvents.status, "failed"))
      .orderBy(desc(tiktokWebhookEvents.receivedAt))
      .limit(FAILED_EVENTS_SHOWN),
    db.select({ count: sql<number>`count(*)::int`, applied: sql<number>`count(*) filter (where ${tiktokOrders.applyState} = 'applied')::int` }).from(tiktokOrders),
    listUnmappedTikTokSkus(db),
  ]);
  const held = await db
    .select({ reason: sql<string>`coalesce(${tiktokOrders.heldReason}, 'unknown')`, count: sql<number>`count(*)::int` })
    .from(tiktokOrders)
    .where(eq(tiktokOrders.applyState, "held"))
    .groupBy(tiktokOrders.heldReason)
    .orderBy(desc(sql`count(*)`));
  return {
    connection,
    connectedByName,
    webhookCounts: { pending: counts?.pending ?? 0, failed: counts?.failed ?? 0 },
    ordersCursor: cursor ?? null,
    failedEvents,
    tiktokOrderCount: orderCount?.count ?? 0,
    unmappedSkuCount: unmapped.length,
    appliedCount: orderCount?.applied ?? 0,
    heldByReason: held,
  };
}

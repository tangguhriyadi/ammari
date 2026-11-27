import "server-only";
import { eq, sql } from "drizzle-orm";
import { getTikTokConnectionView, type TikTokConnectionView } from "@ammari/commerce/tiktok";
import { staffUsers, tiktokWebhookEvents } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";

// Reads for the Integrasi TikTok Shop page and the home banner. No token column is ever selected
// (getTikTokConnectionView picks its columns).

export interface TikTokIntegrationPageData {
  connection: TikTokConnectionView | null;
  connectedByName: string | null;
  webhookCounts: { pending: number; failed: number };
}

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
  return { connection, connectedByName, webhookCounts: { pending: counts?.pending ?? 0, failed: counts?.failed ?? 0 } };
}

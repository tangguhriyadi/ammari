import { getTikTokConnectionView, tiktokConnectionBanner } from "@ammari/commerce/tiktok";
import { defaultDb } from "@/lib/db";
import { TikTokConnectionBanner } from "../settings/integrations/tiktok/_components/tiktok-connection-banner";

/** The TikTok Shop connection banner on Ringkasan (docs/plans/tiktok-shop-integration.md §7.3 step
 * 4): deauthorized or needing a reconnect (red), or the authorization ending soon (amber). Rendered
 * only for staff holding integrations.manage, the only ones who can reconnect. Nothing when there is
 * no connection or it is healthy. */
export async function OverviewTikTokBanner({ now }: { now: Date }) {
  const banner = tiktokConnectionBanner(await getTikTokConnectionView(defaultDb), now);
  return banner ? <TikTokConnectionBanner banner={banner} linkToSettings /> : null;
}

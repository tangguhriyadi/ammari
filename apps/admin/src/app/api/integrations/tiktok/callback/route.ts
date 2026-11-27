import { getStaffSession } from "@/lib/auth/staff-session";
import { defaultDb } from "@/lib/db";
import { getTikTokRuntime, handleTikTokCallback } from "@/lib/integrations/tiktok";

// TikTok Shop OAuth redirect URL (docs/plans/tiktok-shop-integration.md §0, §7.3), registered in
// Partner Center as https://admin.ammari.id/api/integrations/tiktok/callback. proxy.ts already
// sends a request without a staff session to /login; the handler re-checks the session and
// integrations.manage itself (403) before touching anything.
export async function GET(request: Request): Promise<Response> {
  return handleTikTokCallback({
    url: new URL(request.url),
    session: await getStaffSession(),
    db: defaultDb,
    runtime: getTikTokRuntime(),
  });
}

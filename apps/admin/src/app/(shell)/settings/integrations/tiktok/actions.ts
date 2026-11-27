"use server";

import { buildAuthorizeUrl } from "@ammari/tiktok-shop";
import { createTikTokOAuthState, disconnectTikTokShop } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin, revalidateOverview } from "@/lib/admin-revalidate";
import { defaultDb } from "@/lib/db";
import { ActionError } from "@/lib/errors";
import { getTikTokRuntime, TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TIKTOK_CONNECT_ERRORS } from "@/lib/integrations/tiktok-messages";

/** "Hubungkan TikTok Shop" / "Hubungkan ulang" (docs/plans/tiktok-shop-integration.md §7.3 step 1):
 * integrations.manage on the server, then a single-use state (10 minutes, this staff user only) and
 * the authorize link with service_id = TIKTOK_SERVICE_ID. The browser follows the link; the state
 * is never logged. */
export async function startTikTokConnectAction(): Promise<ActionResult<{ url: string }>> {
  const session = await requirePermission(TIKTOK_PERMISSION);
  const runtime = getTikTokRuntime({ requireServiceId: true });
  return runAction(async () => {
    if (!runtime.ok || !runtime.runtime.config.serviceId) {
      console.warn("[tiktok-connect] integration not configured", { problems: runtime.ok ? ["TIKTOK_SERVICE_ID is not set"] : runtime.problems });
      throw new ActionError(TIKTOK_CONNECT_ERRORS.not_configured);
    }
    const state = await createTikTokOAuthState(defaultDb, session.staffUser.id);
    return { url: buildAuthorizeUrl({ serviceId: runtime.runtime.config.serviceId, state }) };
  });
}

/** "Putuskan": wipes the tokens and stops sync (audited). The seller removes the app in Seller
 * Center themselves (phase 1 never writes to TikTok, Q15). */
export async function disconnectTikTokAction(): Promise<ActionResult> {
  const session = await requirePermission(TIKTOK_PERMISSION);
  return runAction(async () => {
    const result = await disconnectTikTokShop(defaultDb, { staffUserId: session.staffUser.id });
    if (!result.ok) throw new ActionError("Tidak ada toko TikTok yang terhubung.");
    revalidateAdmin("/settings");
    revalidateOverview();
    return undefined;
  });
}

"use server";

import { buildAuthorizeUrl } from "@ammari/tiktok-shop";
import { z } from "zod";
import { confirmTikTokBackfill, createTikTokOAuthState, disconnectTikTokShop, setTikTokOrdersApply, startTikTokBackfill } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin, revalidateOverview } from "@/lib/admin-revalidate";
import { defaultDb } from "@/lib/db";
import { ActionError } from "@/lib/errors";
import { getTikTokRuntime, TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TIKTOK_BACKFILL_ERRORS, TIKTOK_CONNECT_ERRORS } from "@/lib/integrations/tiktok-messages";

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

const ordersApplySchema = z.object({ enabled: z.boolean() });

/** The T5 kill switch (docs/plans/tiktok-shop-integration.md §4, migration 0059): "Terapkan pesanan
 * TikTok" on or off, without a deploy. integrations.manage on the server; audited
 * (`tiktok_apply_enable` / `tiktok_apply_disable`). Off: the sync keeps reading and storing orders
 * (the preview) but writes no admin order and no stock. */
export async function setTikTokOrdersApplyAction(input: z.input<typeof ordersApplySchema>): Promise<ActionResult<{ changed: boolean }>> {
  const session = await requirePermission(TIKTOK_PERMISSION);
  const parsed = ordersApplySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Input tidak valid." };
  return runAction(async () => {
    const result = await setTikTokOrdersApply(defaultDb, { enabled: parsed.data.enabled, staffUserId: session.staffUser.id });
    if (!result.ok) throw new ActionError("Hubungkan TikTok Shop dulu.");
    revalidateAdmin("/settings", "/orders", "/packing");
    revalidateOverview();
    return { changed: result.changed };
  });
}

const backfillStartSchema = z.object({ fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** "Ambil riwayat" (docs/plans/tiktok-shop-integration.md T9): starts reading TikTok history from a
 * day ≥ 1 Dec 2026. integrations.manage on the server; audited (`tiktok_backfill_start`). Read only:
 * nothing reaches admin orders or stock until "Terapkan riwayat". */
export async function startTikTokBackfillAction(input: z.input<typeof backfillStartSchema>): Promise<ActionResult> {
  const session = await requirePermission(TIKTOK_PERMISSION);
  const parsed = backfillStartSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: TIKTOK_BACKFILL_ERRORS.invalid_date };
  return runAction(async () => {
    const result = await startTikTokBackfill(defaultDb, { fromDate: parsed.data.fromDate, staffUserId: session.staffUser.id });
    if (!result.ok) throw new ActionError(TIKTOK_BACKFILL_ERRORS[result.reason]);
    revalidateAdmin("/settings");
    return undefined;
  });
}

/** "Terapkan riwayat" (T9): after the preview, lets the sync apply the orders the backfill stored
 * (still only while "Terapkan pesanan" is on). integrations.manage; audited (`tiktok_backfill_confirm`). */
export async function confirmTikTokBackfillAction(): Promise<ActionResult> {
  const session = await requirePermission(TIKTOK_PERMISSION);
  return runAction(async () => {
    const result = await confirmTikTokBackfill(defaultDb, { staffUserId: session.staffUser.id });
    if (!result.ok) throw new ActionError(TIKTOK_BACKFILL_ERRORS[result.reason]);
    revalidateAdmin("/settings", "/orders", "/packing");
    revalidateOverview();
    return undefined;
  });
}

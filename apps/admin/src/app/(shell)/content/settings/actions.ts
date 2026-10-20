"use server";

import type { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { saveStoreSettings } from "@/lib/content/store-settings";
import { saveStoreSettingsSchema } from "@/lib/content/store-settings-schema";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { revalidateStorefrontLayout } from "@/lib/revalidate";

/** Save = live (docs/plans/storefront-cms.md Phase 2) — one action, no separate publish step.
 * Gated by `content.manage`, same as every other Konten action, not a new "settings" permission
 * (see this session's own implementation report for why). apps/web reads `store_settings`
 * uncached, but renders it in the root layout of every page, including the ISR-cached product
 * pages, so the whole storefront is revalidated after the write (revalidateStorefrontLayout).
 * That call never throws: a failure only surfaces as `revalidationOk: false`, never a failed save. */
export async function saveStoreSettingsAction(
  input: z.input<typeof saveStoreSettingsSchema>,
): Promise<ActionResult<{ revalidationOk: boolean }>> {
  const session = await requirePermission("content.manage");
  const parsed = saveStoreSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await saveStoreSettings(parsed.data, session.staffUser.id);
    revalidateAdmin("/content");
    const revalidationOk = (await revalidateStorefrontLayout()).ok;
    return { revalidationOk };
  });
}

/** Re-runs ONLY the storefront revalidation, for the "Coba lagi" link the form shows when a save
 * reported `revalidationOk: false`. Does not touch the DB. */
export async function retryStorefrontRevalidationAction(): Promise<ActionResult<{ revalidationOk: boolean }>> {
  await requirePermission("content.manage");
  return runAction(async () => ({ revalidationOk: (await revalidateStorefrontLayout()).ok }));
}

"use server";

import type { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { saveStoreSettings } from "@/lib/content/store-settings";
import { saveStoreSettingsSchema } from "@/lib/content/store-settings-schema";
import { revalidateAdmin } from "@/lib/admin-revalidate";

/** Save = live (docs/plans/storefront-cms.md Phase 2) — one action, no separate publish step.
 * Gated by `content.manage`, same as every other Konten action, not a new "settings" permission
 * (see this session's own implementation report for why). No revalidation call — apps/web reads
 * `store_settings` uncached on every request (see lib/revalidate.ts's own comment), so a save is
 * visible on the very next request with nothing to invalidate. */
export async function saveStoreSettingsAction(input: z.input<typeof saveStoreSettingsSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = saveStoreSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await saveStoreSettings(parsed.data, session.staffUser.id);
    revalidateAdmin("/content");
    return undefined;
  });
}

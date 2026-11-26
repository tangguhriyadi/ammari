"use server";

import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { clearItemMapping, MAPPING_MESSAGES, setAccountMapping } from "@/lib/accounting/mappings";

// Pemetaan akun (docs/plans/accounting.md Session 3, D-25). accounting.manage edits mappings
// (plan §7) on an accounting.view page, so both are required, re-checked on every action.

const KEYS = ["accounting.view", "accounting.manage"] as const;
const SECTIONS = ["/accounting", "/expense-categories"] as const;

const setSchema = z.object(
  {
    mappingKey: z.string().min(1).max(120),
    accountCode: z.string({ error: MAPPING_MESSAGES.account }).regex(/^[1-9]-[0-9]{4}$/, MAPPING_MESSAGES.account),
  },
  { error: MAPPING_MESSAGES.unknownKey },
);

export async function setAccountMappingAction(input: z.input<typeof setSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? MAPPING_MESSAGES.unknownKey;
    return { ok: false, error: message, fieldErrors: { accountCode: message } };
  }
  return runAction(async () => {
    await setAccountMapping(parsed.data.mappingKey, parsed.data.accountCode, session.staffUser.id);
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

export async function clearItemMappingAction(itemId: string): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (typeof itemId !== "string" || itemId.length > 100) return { ok: false, error: MAPPING_MESSAGES.unknownKey };
  return runAction(async () => {
    await clearItemMapping(itemId, session.staffUser.id);
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

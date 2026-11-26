"use server";

import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { jsonField, lineRows, optionalAttachment, storeJournalAttachment } from "@/lib/accounting/journal-form-data";
import { postOpeningBalance, prevalidateOpeningBalance } from "@/lib/accounting/opening-balance";

// Saldo awal (docs/plans/accounting.md §5.4, D-22, Session 4): accounting.view + accounting.manage
// (plan §7: "manual/opening journals"), checked here on the server for every call.

const KEYS = ["accounting.view", "accounting.manage"] as const;
const INVALID = "Input tidak valid. Muat ulang halaman.";

const proposalsSchema = z
  .array(z.object({ key: z.string().max(200), confirmed: z.boolean(), amount: z.string().max(40), proposedAmount: z.number().int().safe() }, { error: INVALID }), { error: INVALID })
  .max(1000, INVALID);

export async function postOpeningBalanceAction(formData: FormData): Promise<ActionResult<{ entryNo: string }>> {
  const session = await requireAllPermissions(KEYS);
  const proposals = jsonField(formData, "proposals", proposalsSchema);
  const lines = lineRows(formData);
  if (proposals === null || lines === null) return { ok: false, error: INVALID };
  const attachment = optionalAttachment(formData);
  if ("error" in attachment) return { ok: false, error: attachment.error, fieldErrors: { attachment: attachment.error } };

  return runAction(async () => {
    // Every rule before the attachment is stored (postOpeningBalance checks again).
    await prevalidateOpeningBalance({ proposals, lines });
    const stored = await storeJournalAttachment(attachment.file);
    const entry = await postOpeningBalance({ proposals, lines }, stored, session.staffUser.id);
    revalidateAdmin("/accounting");
    return { entryNo: entry.entryNo };
  });
}

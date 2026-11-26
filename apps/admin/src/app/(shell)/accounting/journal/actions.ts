"use server";

import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { lineRows, optionalAttachment, storeJournalAttachment } from "@/lib/accounting/journal-form-data";
import { MANUAL_JOURNAL_MESSAGES, MAX_REVERSAL_REASON_LENGTH } from "@/lib/accounting/manual-journal-input";
import { postManualJournal, prevalidateManualJournal, reverseStaffJournal } from "@/lib/accounting/manual-journals";

// Manual journals (docs/plans/accounting.md §5, §7, Session 4): accounting.view + accounting.manage,
// checked here on the server for every call.

const KEYS = ["accounting.view", "accounting.manage"] as const;
const INVALID = "Input tidak valid. Muat ulang halaman.";

/** "Simpan jurnal": validate everything, then store the optional attachment, then ONE transaction
 * for the attachment row, the entry, its lines and the audit entry. */
export async function postManualJournalAction(formData: FormData): Promise<ActionResult<{ entryNo: string }>> {
  const session = await requireAllPermissions(KEYS);
  const entryDate = formData.get("entryDate");
  const description = formData.get("description");
  const lines = lineRows(formData);
  if (typeof entryDate !== "string" || typeof description !== "string" || lines === null) return { ok: false, error: INVALID };
  const attachment = optionalAttachment(formData);
  if ("error" in attachment) return { ok: false, error: attachment.error, fieldErrors: { attachment: attachment.error } };

  return runAction(async () => {
    const input = { entryDate, description, lines };
    // Every rule before storing anything, so a refused form leaves no object behind.
    await prevalidateManualJournal(input);
    const stored = await storeJournalAttachment(attachment.file);
    const entry = await postManualJournal(input, stored, session.staffUser.id);
    revalidateAdmin("/accounting");
    return { entryNo: entry.entryNo };
  });
}

const reverseSchema = z.object({
  id: z.string().uuid(MANUAL_JOURNAL_MESSAGES.notFound),
  reason: z.string().trim().min(1, MANUAL_JOURNAL_MESSAGES.reasonRequired).max(MAX_REVERSAL_REASON_LENGTH, MANUAL_JOURNAL_MESSAGES.reasonTooLong),
});

/** "Balik jurnal" for a manual or opening journal, with a required reason. */
export async function reverseJournalAction(input: z.input<typeof reverseSchema>): Promise<ActionResult<{ entryNo: string }>> {
  const session = await requireAllPermissions(KEYS);
  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue?.message ?? INVALID;
    return { ok: false, error: message, fieldErrors: issue?.path[0] === "reason" ? { reason: message } : undefined };
  }
  return runAction(async () => {
    const reversal = await reverseStaffJournal(parsed.data.id, parsed.data.reason, session.staffUser.id);
    revalidateAdmin("/accounting");
    return { entryNo: reversal.entryNo };
  });
}

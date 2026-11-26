import "server-only";
import { z } from "zod";
import { PRIVATE_UPLOAD_MAX_INPUT_BYTES, PROOF_MESSAGES } from "@/lib/supplier-payments/messages";
import { processPrivateUpload } from "@/lib/supplier-payments/proof-processing";
import { storePrivateUpload, type StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import { MAX_MANUAL_JOURNAL_LINES, type ManualJournalLineInput } from "./manual-journal-input";

// FormData parsing for the manual journal and opening balance forms (Session 4). Not a "use server"
// module. The lines travel as one JSON field; the attachment is an optional file.

const INVALID = "Input tidak valid. Muat ulang halaman.";
const cell = z.string({ error: INVALID }).max(600, INVALID);

export const lineRowsSchema = z
  .array(z.object({ accountCode: cell, debit: cell, credit: cell, memo: cell.nullable().optional() }, { error: INVALID }), { error: INVALID })
  .max(MAX_MANUAL_JOURNAL_LINES + 20, INVALID);

/** The JSON field `name` parsed with `schema`, or null when it is missing or malformed. */
export function jsonField<T>(formData: FormData, name: string, schema: z.ZodType<T>): T | null {
  const raw = formData.get(name);
  if (typeof raw !== "string" || raw.length > 200_000) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function lineRows(formData: FormData): ManualJournalLineInput[] | null {
  return jsonField(formData, "lines", lineRowsSchema);
}

/** The optional attachment: null when none was chosen, an Indonesian refusal when too large. */
export function optionalAttachment(formData: FormData): { file: File | null } | { error: string } {
  const file = formData.get("attachment");
  if (!(file instanceof File) || file.size === 0) return { file: null };
  if (file.size > PRIVATE_UPLOAD_MAX_INPUT_BYTES) return { error: PROOF_MESSAGES.tooLarge };
  return { file };
}

/** Processed (photo re-encoded, PDF checked) and stored, BEFORE the journal's transaction. */
export async function storeJournalAttachment(file: File | null): Promise<StoredPrivateFile | null> {
  if (!file) return null;
  const processed = await processPrivateUpload(Buffer.from(await file.arrayBuffer()), file.name, { missingMessage: "Lampiran kosong." });
  return storePrivateUpload(processed, "journal_attachment");
}

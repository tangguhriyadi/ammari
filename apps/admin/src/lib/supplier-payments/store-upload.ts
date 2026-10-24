import "server-only";
import { randomUUID } from "node:crypto";
import { PrivateStorageConfigError } from "@ammari/storage";
import type { PrivateFilePurpose } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import { getPrivateStorageClient } from "@/lib/private-storage";
import { getStorageKeyPrefix } from "@/lib/storage";
import { buildPrivateFileKey } from "./private-files";
import type { ProcessedPrivateFile } from "./proof-processing";

// Step 2 of every private upload (docs/plans/purchase-payments.md §5.7): the processed bytes go to
// private storage BEFORE the database transaction, under a key built from a fresh uuid. The
// private_files ROW is inserted only later, inside the payment/attachment transaction, with this
// same id. If that transaction fails, the object stays unreferenced: harmless (the viewing route
// serves only referenced files) and consistent with "proofs are never deleted by code".

export const STORAGE_NOT_CONFIGURED_MESSAGE = "Penyimpanan bukti belum dikonfigurasi.";
const STORAGE_UNREACHABLE_MESSAGE = "Penyimpanan bukti tidak dapat dihubungi. Coba lagi.";

export interface StoredPrivateFile {
  /** The private_files row id to insert; also embedded in the storage key. */
  id: string;
  purpose: PrivateFilePurpose;
  storageKey: string;
  processed: ProcessedPrivateFile;
}

export async function storePrivateUpload(processed: ProcessedPrivateFile, purpose: PrivateFilePurpose): Promise<StoredPrivateFile> {
  const id = randomUUID();
  const storageKey = buildPrivateFileKey({ prefix: getStorageKeyPrefix(), purpose, id, extension: processed.extension });
  try {
    await getPrivateStorageClient().put(storageKey, processed.body, processed.contentType);
  } catch (error) {
    if (error instanceof PrivateStorageConfigError) {
      console.error(`[private-upload] private storage not configured: ${error.message}`);
      throw new ActionError(STORAGE_NOT_CONFIGURED_MESSAGE);
    }
    // Message only: an SDK error can carry request metadata.
    console.error(`[private-upload] put failed for ${purpose} ${id}: ${error instanceof Error ? error.message : String(error)}`);
    throw new ActionError(STORAGE_UNREACHABLE_MESSAGE);
  }
  return { id, purpose, storageKey, processed };
}

import "server-only";
import { eq } from "drizzle-orm";
import { privateFiles, purchaseAttachments, purchases, supplierPayments, type PrivateFileContentType, type PrivateFilePurpose } from "@ammari/db/schema";
import type { PermissionKey } from "@ammari/db/rbac";
import type { Database } from "@/lib/db";

// Lookups and keys for private files (docs/plans/purchase-payments.md §5). The row is inserted
// only inside the payment/attachment transaction (§5.7), never here.

/** Every key a viewer must hold, per purpose (plan §7), checked on every request. */
export const PRIVATE_FILE_VIEW_PERMISSIONS: Record<PrivateFilePurpose, readonly PermissionKey[]> = {
  payment_proof: ["supplier_payments.manage", "finance.view_profit"],
  purchase_invoice: ["inventory.view", "finance.view_profit"],
};

const JAKARTA_YEAR_MONTH = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" });

/** `{prefix}{purpose}/{yyyy}/{mm}/{id}.{ext}` (plan §4.1), year/month in Asia/Jakarta. The id is
 * the private_files row's own (fresh) uuid, so a key is never reused. */
export function buildPrivateFileKey(input: {
  prefix: string;
  purpose: PrivateFilePurpose;
  id: string;
  extension: "jpg" | "pdf";
  now?: Date;
}): string {
  const parts = JAKARTA_YEAR_MONTH.formatToParts(input.now ?? new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${input.prefix}${input.purpose}/${year}/${month}/${input.id}.${input.extension}`;
}

export interface ServablePrivateFile {
  id: string;
  purpose: PrivateFilePurpose;
  storageKey: string;
  contentType: PrivateFileContentType;
  byteSize: number;
  sha256: string;
  /** The name the browser gets: `<payment_no>.jpg` or `<purchase_no>-nota.pdf`. */
  downloadName: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeDownloadName(stem: string, extension: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]/g, "");
  return `${cleaned === "" ? "file" : cleaned}.${extension}`;
}

/** The file, only when a payment (proof) or a purchase attachment (nota) references it; an
 * orphan row or object is never served. Voided payments/attachments still count: they stay in
 * the history with their proof. `null` for a malformed id, an unknown id, or an orphan. */
export async function findServablePrivateFile(db: Database, fileId: string): Promise<ServablePrivateFile | null> {
  if (!UUID_PATTERN.test(fileId)) return null;
  const [row] = await db
    .select({
      id: privateFiles.id,
      purpose: privateFiles.purpose,
      storageKey: privateFiles.storageKey,
      contentType: privateFiles.contentType,
      byteSize: privateFiles.byteSize,
      sha256: privateFiles.sha256,
      paymentNo: supplierPayments.paymentNo,
      purchaseNo: purchases.purchaseNo,
    })
    .from(privateFiles)
    .leftJoin(supplierPayments, eq(supplierPayments.proofFileId, privateFiles.id))
    .leftJoin(purchaseAttachments, eq(purchaseAttachments.fileId, privateFiles.id))
    .leftJoin(purchases, eq(purchases.id, purchaseAttachments.purchaseId))
    .where(eq(privateFiles.id, fileId.toLowerCase()))
    .limit(1);
  if (!row) return null;

  const extension = row.contentType === "application/pdf" ? "pdf" : "jpg";
  let downloadName: string;
  if (row.purpose === "payment_proof" && row.paymentNo) downloadName = safeDownloadName(row.paymentNo, extension);
  else if (row.purpose === "purchase_invoice" && row.purchaseNo) downloadName = safeDownloadName(`${row.purchaseNo}-nota`, extension);
  else return null;

  return {
    id: row.id,
    purpose: row.purpose,
    storageKey: row.storageKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    downloadName,
  };
}

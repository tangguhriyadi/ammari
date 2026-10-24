import { createHash } from "node:crypto";
import { PrivateStorageConfigError } from "@ammari/storage";
import { getStaffSession } from "@/lib/auth/staff-session";
import { defaultDb } from "@/lib/db";
import { getPrivateStorageClient } from "@/lib/private-storage";
import { findServablePrivateFile, PRIVATE_FILE_VIEW_PERMISSIONS } from "@/lib/supplier-payments/private-files";

// The ONLY way a private file (payment proof, supplier nota) leaves storage
// (docs/plans/purchase-payments.md §5.4, A6): no presigned link, no redirect to the bucket. Every
// request re-checks the staff session and the purpose's permissions (§7), so revoking a
// permission takes effect on the next view. Viewing is not audited (A10). proxy.ts already
// redirects a request without a session to /login; the 401 below is the route's own guard.

const NO_STORE = "private, no-store, max-age=0";

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE, Pragma: "no-cache", "X-Content-Type-Options": "nosniff" },
  });
}

// An image response can be locked down completely. A PDF cannot take `sandbox` (it stops Chrome's
// built-in viewer), so it gets only the framing restriction; nosniff + the exact type still apply,
// and PDFs carrying scripts, launch actions or embedded files are refused at upload
// (proof-processing.ts), so what is served inline is a plain document.
const CSP_BY_TYPE = {
  "image/jpeg": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
  "application/pdf": "frame-ancestors 'self'",
} as const;

export async function GET(_request: Request, ctx: RouteContext<"/api/private-files/[fileId]">): Promise<Response> {
  const session = await getStaffSession();
  if (!session) return plain(401, "Unauthorized");
  // Common to every purpose: refuse before touching the database.
  if (!session.permissionKeys.includes("finance.view_profit")) return plain(403, "Forbidden");

  const { fileId } = await ctx.params;
  const file = await findServablePrivateFile(defaultDb, fileId);
  if (!file) return plain(404, "Not found");
  if (!PRIVATE_FILE_VIEW_PERMISSIONS[file.purpose].every((key) => session.permissionKeys.includes(key))) {
    return plain(403, "Forbidden");
  }

  let body: Buffer | null;
  try {
    body = await getPrivateStorageClient().get(file.storageKey);
  } catch (error) {
    if (error instanceof PrivateStorageConfigError) {
      console.error(`[private-files] private storage not configured: ${error.message}`);
      return plain(503, "Penyimpanan bukti belum dikonfigurasi.");
    }
    // Message only: an SDK error can carry request metadata.
    console.error(`[private-files] storage read failed for private_files.id=${file.id}: ${error instanceof Error ? error.message : String(error)}`);
    return plain(502, "Penyimpanan bukti tidak dapat dihubungi. Coba lagi.");
  }
  // A referenced row whose object is gone or altered is an integrity problem, never a quiet 404.
  if (!body) {
    console.error(`[private-files] object missing for private_files.id=${file.id}`);
    return plain(500, "File tidak ditemukan di penyimpanan.");
  }
  if (body.length !== file.byteSize || createHash("sha256").update(body).digest("hex") !== file.sha256) {
    console.error(`[private-files] checksum mismatch for private_files.id=${file.id}`);
    return plain(500, "File di penyimpanan tidak cocok dengan catatan.");
  }

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(body.length),
      "Content-Disposition": `inline; filename="${file.downloadName}"`,
      "Cache-Control": NO_STORE,
      Pragma: "no-cache",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP_BY_TYPE[file.contentType],
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

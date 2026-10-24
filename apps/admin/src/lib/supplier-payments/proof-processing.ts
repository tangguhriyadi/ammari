import "server-only";
import { createHash } from "node:crypto";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, type PDFObject } from "pdf-lib";
import sharp, { type OutputInfo } from "sharp";
import type { PrivateFileContentType } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
// Also applies that module's process-wide sharp.concurrency(1) (2 GB VPS).
import { sniffImageContentType } from "@/lib/products/image-processing";

// File processing for private uploads: payment proofs now, supplier notas later
// (docs/plans/purchase-payments.md §6). Photos are re-encoded to a small, metadata-free JPEG;
// PDFs are stored byte-for-byte. Everything is decided from the bytes, never from the file name
// or the browser-supplied MIME type.

export const PRIVATE_UPLOAD_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const PROOF_IMAGE_MAX_EDGE_PX = 2000;
export const PROOF_IMAGE_TARGET_BYTES = 600 * 1024;
/** Tried in order; the first encode at or under the target wins. If even the last one is over
 * (a pathological, noise-like photo), that last encode is kept rather than refusing a mandatory
 * proof: it is still capped at 2000 px, so it stays bounded. */
export const PROOF_JPEG_QUALITY_LADDER = [82, 76, 70] as const;
// Same RAM guard as the product pipeline (lib/products/image-processing.ts).
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_FILENAME_LENGTH = 255;

export const PROOF_MESSAGES = {
  missing: "Bukti bayar wajib diunggah.",
  unsupported: "Format file tidak didukung. Gunakan foto JPG, PNG, WebP, atau PDF.",
  tooLarge: "Ukuran file maksimal 10 MB.",
  heic: "Foto HEIC belum didukung. Ubah ke JPG lalu unggah ulang.",
  unreadable: "Foto tidak bisa dibaca: rusak atau dimensinya terlalu besar.",
  pdfUnreadable: "PDF tidak bisa dibaca atau rusak. Unggah ulang, atau kirim foto/screenshot buktinya.",
  pdfActive: "PDF ini berisi skrip atau lampiran tersembunyi. Unggah foto/screenshot buktinya saja.",
} as const;

/** A refusal tied to the uploaded file itself. Extends ActionError so runAction turns it into a
 * friendly ActionResult (same as ImageValidationError). */
export class PrivateFileValidationError extends ActionError {}

export type SniffedPrivateUpload = "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | "image/heic";

// ISO-BMFF major brands of HEIC/HEIF stills and sequences. Recognized only to say "convert to
// JPG" (A5); there is no HEIC decoder.
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** Magic-byte sniff. `null` means "not a format we accept" (GIF, AVIF, SVG, HTML, a renamed
 * executable, ...). */
export function sniffPrivateUpload(buffer: Buffer): SniffedPrivateUpload | null {
  const image = sniffImageContentType(buffer);
  if (image) return image;
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("latin1") === "ftyp" &&
    HEIF_BRANDS.has(buffer.subarray(8, 12).toString("latin1"))
  ) {
    return "image/heic";
  }
  return null;
}

/** The name shown in the admin and used for nothing security-relevant (the storage key and the
 * served filename never come from it). Strips any path, control and bidi-override characters,
 * caps the length, and falls back to a neutral name. */
export function sanitizeOriginalFilename(raw: string, fallback = "bukti"): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    // C0/C1 controls, zero-width and direction marks, line/paragraph separators, bidi
    // overrides/isolates (a "gpj.exe" look-alike trick) and the BOM.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .trim();
  const capped = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("").trim();
  return capped === "" ? fallback : capped;
}

export interface ProcessedPrivateFile {
  body: Buffer;
  contentType: PrivateFileContentType;
  extension: "jpg" | "pdf";
  byteSize: number;
  /** Hex sha256 of `body` (what is stored). */
  sha256: string;
  originalFilename: string;
  originalContentType: SniffedPrivateUpload;
  originalByteSize: number;
  /** Hex sha256 of the uploaded bytes (duplicate-proof warning, plan §8). */
  originalSha256: string;
  /** The JPEG quality used, or null for a stored-as-is PDF. */
  jpegQuality: number | null;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Auto-orient from EXIF, cap the long edge at 2000 px (never upscale), sRGB, then JPEG down the
 * quality ladder until the result fits `targetBytes`. `.withMetadata()` is never called, so
 * EXIF (GPS included), XMP, IPTC and ICC are all dropped. */
export async function encodeProofJpeg(
  input: Buffer,
  targetBytes: number = PROOF_IMAGE_TARGET_BYTES,
): Promise<{ body: Buffer; quality: number }> {
  let pixels: { data: Buffer; info: OutputInfo };
  try {
    // One decode + rotate + resize pass into raw pixels, so each ladder step only re-encodes
    // instead of re-decoding the original. Transparency (PNG/WebP) is flattened onto white.
    pixels = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize({ width: PROOF_IMAGE_MAX_EDGE_PX, height: PROOF_IMAGE_MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    // Almost always a corrupt or oversized upload; logged (message only) so a real libvips/OOM
    // failure is not silently filed under "unreadable".
    console.warn(`[proof-processing] image decode failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new PrivateFileValidationError(PROOF_MESSAGES.unreadable);
  }
  const { width, height, channels } = pixels.info;
  const encode = (quality: number) => sharp(pixels.data, { raw: { width, height, channels } }).jpeg({ mozjpeg: true, quality }).toBuffer();

  const [first, ...rest] = PROOF_JPEG_QUALITY_LADDER;
  let result = { body: await encode(first), quality: first as number };
  for (const quality of rest) {
    if (result.body.length <= targetBytes) break;
    result = { body: await encode(quality), quality };
  }
  return result;
}

// Names that make a PDF active content rather than a document: scripts, launching programs,
// embedded/attached files, Flash-era rich media. Links (/URI) and forms are fine.
const ACTIVE_PDF_NAMES = new Set(["JavaScript", "JS", "Launch", "EmbeddedFile", "EmbeddedFiles", "RichMedia"]);

function hasActiveName(object: PDFObject, depth = 0): boolean {
  if (depth > 32) return false;
  if (object instanceof PDFName) return ACTIVE_PDF_NAMES.has(object.decodeText());
  if (object instanceof PDFStream) return hasActiveName(object.dict, depth + 1);
  if (object instanceof PDFArray) return object.asArray().some((item) => hasActiveName(item, depth + 1));
  if (object instanceof PDFDict) {
    return object.entries().some(([key, value]) => ACTIVE_PDF_NAMES.has(key.decodeText()) || hasActiveName(value, depth + 1));
  }
  return false;
}

/** A PDF is stored byte-for-byte and served inline on the admin origin (plan §5.4, §6), so it
 * must actually parse as a PDF and carry no active content. pdf-lib also parses compressed
 * object streams, which a raw byte scan would miss. Encrypted PDFs are still inspected: object
 * names are never encrypted. */
export async function assertPlainPdf(input: Buffer): Promise<void> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: true });
    // pdf-lib tolerates junk after a "%PDF-" header as an empty document; a real proof has pages.
    if (document.getPageCount() < 1) throw new Error("no pages");
  } catch (error) {
    console.warn(`[proof-processing] PDF parse failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new PrivateFileValidationError(PROOF_MESSAGES.pdfUnreadable);
  }
  const active = document.context.enumerateIndirectObjects().some(([, object]) => hasActiveName(object));
  if (active || hasActiveName(document.catalog)) throw new PrivateFileValidationError(PROOF_MESSAGES.pdfActive);
}

/** Validate and process one uploaded private file (plan §6). Throws PrivateFileValidationError
 * with an Indonesian message for anything refused. */
export async function processPrivateUpload(
  input: Buffer,
  rawFilename: string,
  options: { missingMessage?: string; targetBytes?: number } = {},
): Promise<ProcessedPrivateFile> {
  if (input.length === 0) throw new PrivateFileValidationError(options.missingMessage ?? PROOF_MESSAGES.missing);
  if (input.length > PRIVATE_UPLOAD_MAX_INPUT_BYTES) throw new PrivateFileValidationError(PROOF_MESSAGES.tooLarge);

  const sniffed = sniffPrivateUpload(input);
  if (sniffed === "image/heic") throw new PrivateFileValidationError(PROOF_MESSAGES.heic);
  if (!sniffed) throw new PrivateFileValidationError(PROOF_MESSAGES.unsupported);

  const original = {
    originalFilename: sanitizeOriginalFilename(rawFilename),
    originalContentType: sniffed,
    originalByteSize: input.length,
    originalSha256: sha256Hex(input),
  };

  if (sniffed === "application/pdf") {
    await assertPlainPdf(input);
    const body = Buffer.from(input);
    return { ...original, body, contentType: "application/pdf", extension: "pdf", byteSize: body.length, sha256: original.originalSha256, jpegQuality: null };
  }

  const { body, quality } = await encodeProofJpeg(input, options.targetBytes);
  return { ...original, body, contentType: "image/jpeg", extension: "jpg", byteSize: body.length, sha256: sha256Hex(body), jpegQuality: quality };
}

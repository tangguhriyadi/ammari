import "server-only";
import sharp from "sharp";
import { ActionError } from "./errors";

// The VPS has only 2 GB RAM (docs/SPEC.md's pre-deploy checklist) — libvips can otherwise spawn
// one thread per CPU core for a single resize, and this app can have several uploads in flight
// (one admin session at a time, but "sequential per-file" uploads from the client still overlap
// with whatever else the Node process is doing). Set once, process-wide, at module load.
sharp.concurrency(1);

export const IMAGE_SIZES = [400, 800, 1600] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;
// 40 megapixels — comfortably above any real product photo, well below what would risk
// exhausting the VPS's 2 GB RAM during decode (libvips' peak memory scales with pixel count).
const MAX_INPUT_PIXELS = 40_000_000;

export type AcceptedImageContentType = "image/jpeg" | "image/png" | "image/webp";

/** A refusal tied to the uploaded file itself (wrong type, too large, corrupt, oversized
 * dimensions) rather than to one form field — extends ActionError so runAction's existing
 * FieldError/ActionError handling (apps/admin/src/lib/products/action-result.ts) already turns
 * it into a friendly ActionResult without any extra wiring at the action layer. */
export class ImageValidationError extends ActionError {}

/** Validates by content, not file extension or the browser-supplied MIME type — a renamed
 * .exe or an SVG-with-.jpg-extension must not slip through just because the client claims
 * otherwise. Checks only the first bytes needed per format (magic numbers), not a full parse. */
export function sniffImageContentType(buffer: Buffer): AcceptedImageContentType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export interface ProcessedImage {
  /** Dimensions AFTER EXIF auto-rotation — matches what's visually rendered, even when
   * orientation swaps width and height. */
  width: number;
  height: number;
  /** One WebP buffer per size in IMAGE_SIZES, never upscaled past the (rotated) original. */
  sizes: Record<ImageSize, Buffer>;
}

/** Full pipeline for one uploaded file: validate (size, then real content type via magic
 * bytes) -> auto-rotate from EXIF -> strip ALL metadata (EXIF/GPS/ICC — the default behavior
 * whenever `.withMetadata()` is never called, per sharp's own docs) -> produce one WebP buffer
 * per IMAGE_SIZES entry, each capped with `withoutEnlargement: true` so a smaller original is
 * never upscaled. `limitInputPixels` + `failOn: "error"` guard the VPS's limited RAM against an
 * oversized or corrupt file; both turn into the same friendly `ImageValidationError`. */
export async function processUploadedImage(buffer: Buffer): Promise<ProcessedImage> {
  if (buffer.length > MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw new ImageValidationError("Ukuran file maksimal 10 MB.");
  }
  if (!sniffImageContentType(buffer)) {
    throw new ImageValidationError("Format file harus JPEG, PNG, atau WebP.");
  }

  let rotated: Buffer;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const result = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .toBuffer({ resolveWithObject: true });
    rotated = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch {
    throw new ImageValidationError("Foto tidak bisa dibaca — rusak atau dimensinya terlalu besar.");
  }
  if (!width || !height) {
    throw new ImageValidationError("Foto tidak bisa dibaca — rusak atau dimensinya terlalu besar.");
  }

  // Sequential, not Promise.all — sharp.concurrency(1) above already serializes libvips' own
  // work, but running the three resize+encode calls one at a time (rather than issuing all
  // three JS-side at once) keeps peak buffer memory to one output at a time, same reasoning.
  const sizes: Partial<Record<ImageSize, Buffer>> = {};
  for (const size of IMAGE_SIZES) {
    sizes[size] = await sharp(rotated, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp()
      .toBuffer();
  }

  return { width, height, sizes: sizes as Record<ImageSize, Buffer> };
}

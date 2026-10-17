// Browser-only — downscales a photo before it leaves the device, so a 10 MB phone photo doesn't
// have to cross the network (and the 12 MB server action body limit) on every upload. This is a
// performance optimization ONLY: the server independently re-validates size/type/dimensions and
// does the real EXIF-aware rotation + metadata strip (see image-processing.ts) regardless of
// what happens here, so any failure below just falls back to uploading the original file
// unchanged rather than blocking the upload.
//
// Timing is logged (dev-only, see the `process.env.NODE_ENV` check below) because "uploads are
// slow" was reported on phone photos even with this resize already in place, on both dev and
// prod — the console line here plus the matching server-side `[upload-timing]` log (see
// image-queries.ts / content-image-queries.ts) narrow down which stage (client resize, network,
// sharp, or S3 PUT) is actually the bottleneck, instead of guessing.
const MAX_LONG_EDGE = 2400;
// Below both this size AND MAX_LONG_EDGE, re-encoding would only cost time for no real upload-
// size benefit — skip entirely. An image under MAX_LONG_EDGE but still large (e.g. an
// uncompressed screenshot-like PNG) is NOT skipped: its dimensions stay the same (never
// upscaled) but it's still redrawn/re-encoded to actually shrink the byte count.
const SKIP_IF_UNDER_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export interface ResizeTarget {
  shouldProcess: boolean;
  width: number;
  height: number;
}

/** Pure sizing decision, no browser APIs — unit-tested directly (client-image-resize.test.ts)
 * without needing createImageBitmap/canvas, neither available outside a real browser. `width`/
 * `height` are the ORIGINAL dimensions when `shouldProcess` is false, and the scaled-down
 * dimensions (long edge capped at MAX_LONG_EDGE, never upscaled past the original) when true. */
export function computeResizeTarget(width: number, height: number, fileSizeBytes: number): ResizeTarget {
  const longEdge = Math.max(width, height);
  if (fileSizeBytes <= SKIP_IF_UNDER_BYTES && longEdge <= MAX_LONG_EDGE) {
    return { shouldProcess: false, width, height };
  }
  const scale = Math.min(1, MAX_LONG_EDGE / longEdge); // 1 (no scaling) when already under the cap
  return { shouldProcess: true, width: Math.round(width * scale), height: Math.round(height * scale) };
}

export interface DownscaleResult {
  file: File;
  /** False when the original was already small enough to skip, or decoding/encoding failed and
   * the original was returned unchanged. Callers that want to show timing/size info (dev-only —
   * see content-image-field.tsx / use-photo-staging.ts) use this plus the byte counts below. */
  processed: boolean;
  timingMs: number;
  inputBytes: number;
  outputBytes: number;
}

function unchanged(file: File, timingMs: number): DownscaleResult {
  return { file, processed: false, timingMs, inputBytes: file.size, outputBytes: file.size };
}

export async function downscaleImageForUpload(file: File): Promise<DownscaleResult> {
  if (!file.type.startsWith("image/")) return unchanged(file, 0);

  const started = performance.now();
  try {
    // `imageOrientation: "from-image"` is already createImageBitmap's default, but spelled out
    // explicitly — relying on an unspecified default for EXIF-rotation-sensitive output isn't
    // something to leave implicit.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const target = computeResizeTarget(bitmap.width, bitmap.height, file.size);
      if (!target.shouldProcess) return unchanged(file, Math.round(performance.now() - started));

      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return unchanged(file, Math.round(performance.now() - started));
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);

      // PNG re-encodes as PNG (lossless, keeps alpha) — canvas composites transparent pixels
      // onto an opaque backdrop before JPEG-encoding, which would otherwise silently turn a
      // transparent background black. Everything else (JPEG/WebP input, no alpha channel to
      // lose) re-encodes as JPEG for the smaller upload.
      const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, outputType, outputType === "image/jpeg" ? JPEG_QUALITY : undefined),
      );
      const timingMs = Math.round(performance.now() - started);
      if (!blob) return unchanged(file, timingMs);

      const outFile = new File([blob], file.name, { type: outputType });
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[image-resize] ${file.name}: ${bitmap.width}x${bitmap.height} (${file.size}B) -> ` +
            `${target.width}x${target.height} (${outFile.size}B) in ${timingMs}ms`,
        );
      }
      return { file: outFile, processed: true, timingMs, inputBytes: file.size, outputBytes: outFile.size };
    } finally {
      bitmap.close();
    }
  } catch {
    return unchanged(file, Math.round(performance.now() - started));
  }
}

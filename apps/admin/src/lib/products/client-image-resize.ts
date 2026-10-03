// Browser-only — downscales a photo before it leaves the device, so a 10 MB phone photo doesn't
// have to cross the network (and the 12 MB server action body limit) on every upload. This is a
// performance optimization ONLY: the server independently re-validates size/type/dimensions and
// does the real EXIF-aware rotation + metadata strip (see image-processing.ts) regardless of
// what happens here, so any failure below just falls back to uploading the original file
// unchanged rather than blocking the upload.
const MAX_LONG_EDGE = 2400;
const JPEG_QUALITY = 0.9;

export async function downscaleImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  try {
    const bitmap = await createImageBitmap(file);
    try {
      const longEdge = Math.max(bitmap.width, bitmap.height);
      if (longEdge <= MAX_LONG_EDGE) return file; // already smaller — skip re-encoding entirely

      const scale = MAX_LONG_EDGE / longEdge;
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, width, height);

      // PNG re-encodes as PNG (lossless, keeps alpha) — canvas composites transparent pixels
      // onto an opaque backdrop before JPEG-encoding, which would otherwise silently turn a
      // transparent background black. Everything else (JPEG/WebP input, no alpha channel to
      // lose) re-encodes as JPEG for the smaller upload.
      const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, outputType, outputType === "image/jpeg" ? JPEG_QUALITY : undefined),
      );
      if (!blob) return file;
      return new File([blob], file.name, { type: outputType });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

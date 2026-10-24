import { createHash, randomBytes } from "node:crypto";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  encodeProofJpeg,
  PRIVATE_UPLOAD_MAX_INPUT_BYTES,
  PrivateFileValidationError,
  processPrivateUpload,
  PROOF_IMAGE_TARGET_BYTES,
  PROOF_MESSAGES,
  sanitizeOriginalFilename,
  sniffPrivateUpload,
} from "./proof-processing";

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } } });
}

/** A wide image whose LEFT half is red and right half blue, so a rotation is detectable from the
 * pixels, not just the reported dimensions. */
async function halfRedHalfBlue(width: number, height: number): Promise<Buffer> {
  const half = Math.floor(width / 2);
  const blue = await sharp({ create: { width: width - half, height, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .composite([{ input: blue, left: half, top: 0 }])
    .jpeg()
    .toBuffer();
}

/** Random noise compresses badly, so it is a reliable "big JPEG" fixture. */
async function noise(width: number, height: number): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** A receipt-like photo: mostly flat paper with dark text-ish bars and mild sensor noise. */
async function receiptLike(width: number, height: number): Promise<Buffer> {
  const bars = [];
  const bar = await sharp({ create: { width: Math.floor(width * 0.7), height: 18, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .png()
    .toBuffer();
  for (let top = 80; top < height - 40; top += 60) bars.push({ input: bar, left: Math.floor(width * 0.1), top });
  const grain = await sharp(randomBytes(width * height), { raw: { width, height, channels: 1 } })
    .linear(0.06, 0)
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 236, g: 232, b: 222 } } })
    .composite([...bars, { input: grain, blend: "add" }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** A real one-page PDF. pdf-lib saves with compressed object streams by default, so the
 * active-content tests below also prove names hidden in an object stream are found. */
async function makePdf(mutate?: (document: PDFDocument) => void | Promise<void>, useObjectStreams = true): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]).drawText("Bukti transfer Rp 1.500.000");
  await mutate?.(document);
  return Buffer.from(await document.save({ useObjectStreams }));
}

function heicHeader(brand: string): Buffer {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(24, 0);
  box.write("ftyp", 4, "latin1");
  box.write(brand, 8, "latin1");
  return box;
}

describe("sniffPrivateUpload", () => {
  test("recognizes JPEG, PNG, WebP and PDF by content", async () => {
    expect(sniffPrivateUpload(await solid(4, 4).jpeg().toBuffer())).toBe("image/jpeg");
    expect(sniffPrivateUpload(await solid(4, 4).png().toBuffer())).toBe("image/png");
    expect(sniffPrivateUpload(await solid(4, 4).webp().toBuffer())).toBe("image/webp");
    expect(sniffPrivateUpload(Buffer.from("%PDF-1.7\n..."))).toBe("application/pdf");
  });

  test.each(["heic", "heix", "mif1", "msf1", "hevc"])("recognizes HEIF brand %s (only to refuse it)", (brand) => {
    expect(sniffPrivateUpload(heicHeader(brand))).toBe("image/heic");
  });

  test("rejects GIF, AVIF, SVG, HTML and an empty buffer", () => {
    expect(sniffPrivateUpload(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))).toBeNull();
    expect(sniffPrivateUpload(heicHeader("avif"))).toBeNull();
    expect(sniffPrivateUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffPrivateUpload(Buffer.from("<!doctype html><script>alert(1)</script>"))).toBeNull();
    expect(sniffPrivateUpload(Buffer.alloc(0))).toBeNull();
  });
});

describe("processPrivateUpload: refusals", () => {
  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateFileValidationError);
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  }

  test("empty file -> proof required", async () => {
    expect(await refusal(processPrivateUpload(Buffer.alloc(0), "a.jpg"))).toBe(PROOF_MESSAGES.missing);
  });

  test("HEIC -> asks for JPG (A5), even when renamed to .jpg", async () => {
    expect(await refusal(processPrivateUpload(heicHeader("heic"), "IMG_0001.jpg"))).toBe("Foto HEIC belum didukung. Ubah ke JPG lalu unggah ulang.");
  });

  test("spoofed extension: an HTML file named bukti.jpg / bukti.pdf is refused", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(await refusal(processPrivateUpload(html, "bukti.jpg"))).toBe(PROOF_MESSAGES.unsupported);
    expect(await refusal(processPrivateUpload(html, "bukti.pdf"))).toBe(PROOF_MESSAGES.unsupported);
  });

  test("a file that only starts with %PDF- but is not a PDF is refused", async () => {
    expect(await refusal(processPrivateUpload(Buffer.from("%PDF-1.7\n<script>alert(1)</script>"), "bukti.pdf"))).toBe(PROOF_MESSAGES.pdfUnreadable);
  });

  test.each([true, false])("a PDF with an OpenAction JavaScript is refused (object streams: %s)", async (useObjectStreams) => {
    const pdf = await makePdf((document) => {
      const action = document.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert(1)") });
      document.catalog.set(PDFName.of("OpenAction"), document.context.register(action));
    }, useObjectStreams);
    expect(await refusal(processPrivateUpload(pdf, "bukti.pdf"))).toBe(PROOF_MESSAGES.pdfActive);
  });

  test("a PDF with an embedded file attachment is refused", async () => {
    const pdf = await makePdf(async (document) => {
      await document.attach(Buffer.from("MZ fake exe"), "invoice.exe", { mimeType: "application/octet-stream" });
    });
    expect(await refusal(processPrivateUpload(pdf, "bukti.pdf"))).toBe(PROOF_MESSAGES.pdfActive);
  });

  test("a PDF with a Launch action is refused", async () => {
    const pdf = await makePdf((document) => {
      document.catalog.set(PDFName.of("OpenAction"), document.context.obj({ S: "Launch", F: PDFString.of("calc.exe") }));
    });
    expect(await refusal(processPrivateUpload(pdf, "bukti.pdf"))).toBe(PROOF_MESSAGES.pdfActive);
  });

  test("GIF is refused", async () => {
    const gif = await solid(4, 4).gif().toBuffer();
    expect(await refusal(processPrivateUpload(gif, "a.gif"))).toBe(PROOF_MESSAGES.unsupported);
  });

  test("a plain PDF with a link (URI action) is accepted", async () => {
    const pdf = await makePdf((document) => {
      document.catalog.set(PDFName.of("OpenAction"), document.context.obj({ S: "URI", URI: PDFString.of("https://bank.example") }));
    });
    await expect(processPrivateUpload(pdf, "bukti.pdf")).resolves.toMatchObject({ contentType: "application/pdf" });
  });

  test("PDF over 10 MB is refused; exactly 10 MB is accepted", async () => {
    const pdf = await makePdf();
    const atLimit = Buffer.concat([pdf, Buffer.alloc(PRIVATE_UPLOAD_MAX_INPUT_BYTES - pdf.length, 0x20)]);
    expect(atLimit.length).toBe(PRIVATE_UPLOAD_MAX_INPUT_BYTES);
    await expect(processPrivateUpload(atLimit, "nota.pdf")).resolves.toMatchObject({ contentType: "application/pdf" });
    const over = Buffer.concat([atLimit, Buffer.from(" ")]);
    expect(await refusal(processPrivateUpload(over, "nota.pdf"))).toBe("Ukuran file maksimal 10 MB.");
  });

  test("an image over 40 megapixels is refused", async () => {
    const huge = await solid(8000, 5001).png({ compressionLevel: 9 }).toBuffer();
    expect(huge.length).toBeLessThan(PRIVATE_UPLOAD_MAX_INPUT_BYTES);
    expect(await refusal(processPrivateUpload(huge, "huge.png"))).toBe(PROOF_MESSAGES.unreadable);
  });

  test("a truncated JPEG is refused as unreadable", async () => {
    const jpeg = await receiptLike(600, 400);
    expect(await refusal(processPrivateUpload(jpeg.subarray(0, Math.floor(jpeg.length / 2)), "a.jpg"))).toBe(PROOF_MESSAGES.unreadable);
  });
});

describe("processPrivateUpload: PDF", () => {
  test("stored byte-for-byte with matching checksums", async () => {
    const pdf = await makePdf();
    const result = await processPrivateUpload(pdf, "nota-maret.pdf");
    expect(result.body.equals(pdf)).toBe(true);
    expect(result).toMatchObject({
      contentType: "application/pdf",
      extension: "pdf",
      byteSize: pdf.length,
      sha256: sha256(pdf),
      originalFilename: "nota-maret.pdf",
      originalContentType: "application/pdf",
      originalByteSize: pdf.length,
      originalSha256: sha256(pdf),
      jpegQuality: null,
    });
  });
});

describe("processPrivateUpload: images", () => {
  test("EXIF orientation 6 is applied: output is rotated and carries no EXIF/GPS/orientation", async () => {
    // Stored 400x200 with left red / right blue; orientation 6 means "rotate 90° CW to display".
    const input = await sharp(await halfRedHalfBlue(400, 200))
      .withMetadata({ orientation: 6, exif: { IFD0: { Make: "TestCam", Copyright: "GPS:-6.9,107.6" } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processPrivateUpload(input, "bukti.jpg");
    const meta = await sharp(result.body).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([200, 400]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(result.body.includes(Buffer.from("TestCam"))).toBe(false);
    expect(result.body.includes(Buffer.from("GPS:"))).toBe(false);

    // After a CW rotation the stored left (red) half becomes the top.
    const { data, info } = await sharp(result.body).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const [topR, , topB] = pixel(100, 50);
    const [bottomR, , bottomB] = pixel(100, 350);
    expect(topR).toBeGreaterThan(200);
    expect(topB).toBeLessThan(60);
    expect(bottomB).toBeGreaterThan(200);
    expect(bottomR).toBeLessThan(60);
  });

  test("PNG (with transparency) becomes an opaque JPEG", async () => {
    const png = await sharp({ create: { width: 50, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const result = await processPrivateUpload(png, "bukti.png");
    const meta = await sharp(result.body).metadata();
    expect(result).toMatchObject({ contentType: "image/jpeg", extension: "jpg", originalContentType: "image/png" });
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);
  });

  test("WebP is accepted and re-encoded to JPEG", async () => {
    const webp = await solid(60, 40).webp().toBuffer();
    const result = await processPrivateUpload(webp, "bukti.webp");
    expect(result.originalContentType).toBe("image/webp");
    expect((await sharp(result.body).metadata()).format).toBe("jpeg");
  });

  test("4000x3000 -> 2000x1500 (long edge capped at 2000)", async () => {
    const result = await processPrivateUpload(await receiptLike(4000, 3000), "besar.jpg");
    const meta = await sharp(result.body).metadata();
    expect([meta.width, meta.height]).toEqual([2000, 1500]);
  });

  test("a portrait 1500x4500 -> 667x2000", async () => {
    const result = await processPrivateUpload(await solid(1500, 4500).jpeg().toBuffer(), "tinggi.jpg");
    const meta = await sharp(result.body).metadata();
    expect([meta.width, meta.height]).toEqual([667, 2000]);
  });

  test("a small image is never upscaled", async () => {
    const result = await processPrivateUpload(await solid(320, 240).jpeg().toBuffer(), "kecil.jpg");
    const meta = await sharp(result.body).metadata();
    expect([meta.width, meta.height]).toEqual([320, 240]);
  });

  test("a receipt-like phone photo lands at or under 600 KB at quality 82", async () => {
    const result = await processPrivateUpload(await receiptLike(4032, 3024), "IMG_1234.jpg");
    expect(result.byteSize).toBeLessThanOrEqual(PROOF_IMAGE_TARGET_BYTES);
    expect(result.jpegQuality).toBe(82);
  });

  test("records size and checksums of both the stored and the uploaded bytes", async () => {
    const input = await receiptLike(800, 600);
    const result = await processPrivateUpload(input, "bukti.jpg");
    expect(result.byteSize).toBe(result.body.length);
    expect(result.sha256).toBe(sha256(result.body));
    expect(result.originalByteSize).toBe(input.length);
    expect(result.originalSha256).toBe(sha256(input));
    expect(result.sha256).not.toBe(result.originalSha256);
  });
});

describe("encodeProofJpeg quality ladder", () => {
  test("steps 82 -> 76 -> 70 and stops at the first encode within the target", async () => {
    const input = await noise(900, 900);
    const at82 = await encodeProofJpeg(input, Number.MAX_SAFE_INTEGER);
    expect(at82.quality).toBe(82);
    const at70 = await encodeProofJpeg(input, 1);
    expect(at70.quality).toBe(70);
    expect(at70.body.length).toBeLessThan(at82.body.length);

    // A target just under the q82 size forces exactly one step down.
    const stepped = await encodeProofJpeg(input, at82.body.length - 1);
    expect(stepped.quality).toBe(76);
    expect(stepped.body.length).toBeLessThan(at82.body.length);
  });

  test("keeps the quality-70 encode when even that is over the target (never refuses a proof for size)", async () => {
    const result = await encodeProofJpeg(await noise(300, 300), 1);
    expect(result.quality).toBe(70);
    expect((await sharp(result.body).metadata()).format).toBe("jpeg");
  });
});

describe("sanitizeOriginalFilename", () => {
  test("drops any path, control and bidi-override characters", () => {
    expect(sanitizeOriginalFilename("C:\\Users\\a\\bukti.jpg")).toBe("bukti.jpg");
    expect(sanitizeOriginalFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOriginalFilename("bukti\u0000\r\n.jpg")).toBe("bukti.jpg");
    expect(sanitizeOriginalFilename("bukti\u202Egpj.exe")).toBe("buktigpj.exe");
    expect(sanitizeOriginalFilename("\ufeffbu\u200bkti\u200f\u2028.jpg")).toBe("bukti.jpg");
  });

  test("caps at 255 characters and falls back when nothing is left", () => {
    expect(Array.from(sanitizeOriginalFilename("é".repeat(400))).length).toBe(255);
    expect(sanitizeOriginalFilename("   ")).toBe("bukti");
    expect(sanitizeOriginalFilename("dir/")).toBe("bukti");
  });
});

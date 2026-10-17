// Copies this directory's third-party brand logos (Google sign-in "G", payment-method marks)
// verbatim, and GENERATES Ammari's own logo mark (trimmed, resized, optimized — see
// generateAmmariLogos below) into both apps' own public/logos/ — Next.js serves static files
// only from an app's own public/, so there's no way to reference packages/ui/assets/* directly
// at runtime; this keeps ONE source of truth here (same "regenerate via script" convention as
// generate-fallback-images.mjs in this same directory) instead of hand-copying and letting the
// two apps' copies silently drift apart.
//
// Re-run after replacing any source file (from the repo root):
//
//   node packages/ui/assets/copy-brand-logos.mjs
//
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolves `sharp` from apps/admin's node_modules, since that's the only workspace package with
// it installed — same reasoning, same technique as this directory's own
// generate-fallback-images.mjs (see that file's doc comment). Derived from `here` rather than
// `process.cwd()` so this script works regardless of which directory it's invoked from.
const require = createRequire(path.join(here, "../../../apps/admin/package.json"));
const sharp = require("sharp");

// Source filename -> served filename. Renamed only to drop the source's accidental double
// extension (gopay-logo.svg.svg) and a consistent "-logo" suffix — never re-encoded or altered.
// The two Ammari logo entries are NOT in here — those are GENERATED (see generateAmmariLogos),
// never copied verbatim: the 1254px originals are 259 KB/1.1 MB, far too large to ship unoptimized
// (next/image's optimizer is disabled app-wide, `images.unoptimized: true`, so whatever bytes
// land in public/ are exactly what every visitor downloads).
const FILES = {
  "google-logo.svg": "google.svg",
  "qris-logo.svg": "qris.svg",
  "gopay-logo.svg.svg": "gopay.svg",
  "shopeepay-logo.svg": "shopeepay.svg",
  "va-logo.svg": "va.svg",
};

const targets = [path.join(here, "../../../apps/web/public/logos"), path.join(here, "../../../apps/admin/public/logos")];

for (const target of targets) {
  mkdirSync(target, { recursive: true });
  for (const [source, dest] of Object.entries(FILES)) {
    copyFileSync(path.join(here, source), path.join(target, dest));
    console.log(`wrote ${path.join(target, dest)}`);
  }
}

// Largest size either call site actually displays the logo at (apps/web/src/components/
// wordmark.tsx: 24px header, 28px footer) — rendering the source art at 4x that keeps it crisp on
// 2x/3x-DPI phone screens without shipping the 1254px originals. wordmark.tsx reads the exact
// generated pixel dimensions (logged below) as the intrinsic `width`/`height` it passes to
// next/image, then scales down to the displayed size via CSS (`height`, `width: auto`) — so if
// this number ever changes, update both here and there.
const LARGEST_DISPLAY_HEIGHT_PX = 28;
const RENDER_HEIGHT_PX = LARGEST_DISPLAY_HEIGHT_PX * 4;

/** Generates the two served Ammari logo files from `logo-ammari-primary.png` alone — see this
 * function's two steps for why `logo-ammari-white.png` (the source file) is never used as a
 * serving source, only kept around in this directory for reference/future re-export. */
async function generateAmmariLogos(outputTargets) {
  const primarySource = path.join(here, "logo-ammari-primary.png");

  // 1. Trim the source's transparent padding, then resize to RENDER_HEIGHT_PX tall — trimming
  // FIRST means "resize to 112px tall" means the MARK itself ends up 112px tall, not the padded
  // 1254px square canvas scaled down (which would leave the glyph tiny inside the displayed box).
  const trimmed = await sharp(primarySource).trim().toBuffer();
  const resized = await sharp(trimmed).resize({ height: RENDER_HEIGHT_PX }).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const { data, info } = resized;

  const primaryPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  // 2. Derive the white mark from the PRIMARY's own alpha channel instead of using
  // logo-ammari-white.png (the source file) as a serving source: that file is not a clean
  // cutout — every pixel across its canvas carries a ~20-25% white alpha wash instead of true
  // alpha=0 outside the mark, which shows as a faint whitish box behind it on the footer's
  // brand-coloured background (filed in docs/design/storefront.md §9's prior revision). Painting
  // the primary's own real cutout shape white instead produces a correct version with no such
  // box. Safe ONLY because the primary mark is a single flat colour, verified by hand before
  // this script was written (sampling every fully-opaque pixel: R 90-106, G 73-88, B 72-86 — a
  // ~6%-of-255 spread consistent with anti-aliasing/PNG quantization noise around one colour,
  // not a multi-colour mark) — recolouring a multi-colour mark this way would be wrong, so don't
  // reuse this technique without re-verifying that if the source art ever changes.
  const whiteData = Buffer.from(data);
  for (let i = 0; i < whiteData.length; i += info.channels) {
    whiteData[i] = 255;
    whiteData[i + 1] = 255;
    whiteData[i + 2] = 255;
    // Alpha (i + 3) is left untouched — that's what preserves the primary's real mark shape.
  }
  const whitePng = await sharp(whiteData, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  console.log(
    `generated ammari-primary.png: ${info.width}x${info.height}, ${primaryPng.length} bytes; ` +
      `ammari-white.png: ${info.width}x${info.height}, ${whitePng.length} bytes`,
  );

  for (const target of outputTargets) {
    writeFileSync(path.join(target, "ammari-primary.png"), primaryPng);
    writeFileSync(path.join(target, "ammari-white.png"), whitePng);
    console.log(`wrote ${path.join(target, "ammari-primary.png")}`);
    console.log(`wrote ${path.join(target, "ammari-white.png")}`);
  }
}

await generateAmmariLogos(targets);

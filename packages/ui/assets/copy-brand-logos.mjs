// Copies this directory's third-party brand logos (Google sign-in "G", payment-method marks) into
// both apps' own public/logos/ — Next.js serves static files only from an app's own public/, so
// there's no way to reference packages/ui/assets/* directly at runtime; this keeps ONE source of
// truth here (same "regenerate via script" convention as generate-fallback-images.mjs in this
// same directory) instead of hand-copying and letting the two apps' copies silently drift apart.
// Re-run after replacing any source file:
//
//   node packages/ui/assets/copy-brand-logos.mjs
//
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Source filename -> served filename. Renamed only to drop the source's accidental double
// extension (gopay-logo.svg.svg) and a consistent "-logo" suffix — never re-encoded or altered.
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

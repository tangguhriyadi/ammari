// Generates the storefront's (apps/web) product placeholder: the image shown wherever a product
// or colour has no photo at all (tiles, PDP gallery, OG/JSON-LD). A flat --color-image-bg
// (#eeeae7, apps/web/src/app/globals.css) canvas with the Ammari logo mark centred, built from
// this directory's logo-ammari-primary.png. Re-run after replacing that source (from anywhere):
//
//   node packages/ui/assets/generate-storefront-placeholder.mjs
//
// Writes into apps/web/public/images/:
//   - product-placeholder-{800,1600}.webp: 2:3 portrait, the exact ratio every storefront image
//     container uses (aspect-[2/3]), in the two widths the storefront requests (tiles 800, PDP
//     gallery 1600), so swapping the placeholder in never shifts layout.
//   - product-placeholder-og.jpg: 1200x630 landscape for Open Graph/JSON-LD (crawlers expect a
//     JPEG/PNG there, not WebP).
//
// Separate from generate-fallback-images.mjs (apps/admin's 4:5 hanger illustration): the
// storefront needs its own 2:3 ratio and the brand mark rather than the admin's working
// placeholder. Resolves `sharp` from apps/admin's node_modules, same as that script.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../apps/admin/package.json"));
const sharp = require("sharp");

const BACKGROUND = "#eeeae7";
const source = path.join(here, "logo-ammari-primary.png");
const outDir = path.join(here, "../../../apps/web/public/images");
mkdirSync(outDir, { recursive: true });

async function render({ width, height, logoHeight, file, format }) {
  const logo = await sharp(source).trim().resize({ height: logoHeight }).toBuffer();
  let image = sharp({ create: { width, height, channels: 3, background: BACKGROUND } }).composite([{ input: logo, gravity: "center" }]);
  image = format === "jpeg" ? image.jpeg({ quality: 85 }) : image.webp({ quality: 85 });
  const outPath = path.join(outDir, file);
  await image.toFile(outPath);
  console.log(`wrote ${outPath}`);
}

for (const width of [800, 1600]) {
  await render({ width, height: (width * 3) / 2, logoHeight: Math.round(width * 0.22), file: `product-placeholder-${width}.webp`, format: "webp" });
}
await render({ width: 1200, height: 630, logoHeight: 200, file: "product-placeholder-og.jpg", format: "jpeg" });

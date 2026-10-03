// Regenerates apps/admin/public/images/fallback-product-{400,800,1600}.webp from this
// directory's fallback-image.png (the owner's placeholder, portrait 4:5) — run again whenever
// that source PNG is replaced:
//
//   node packages/ui/assets/generate-fallback-images.mjs
//
// (run from the repo root; resolves `sharp` from apps/admin's node_modules, since that's the
// only workspace package with it installed — see apps/admin/src/lib/products/image-processing.ts
// for the same dependency).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(process.cwd(), "apps/admin/package.json"));
const sharp = require("sharp");

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "fallback-image.png");
const outDir = path.join(here, "../../../apps/admin/public/images");

const sizes = [400, 800, 1600];

for (const size of sizes) {
  const outPath = path.join(outDir, `fallback-product-${size}.webp`);
  await sharp(source)
    .resize({ width: size, height: Math.round((size * 5) / 4), fit: "cover" })
    .webp()
    .toFile(outPath);
  console.log(`wrote ${outPath}`);
}

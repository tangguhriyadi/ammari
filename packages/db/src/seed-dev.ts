// Dev-only sample data — never part of the regular seed (see seed.ts), and never runs against
// anything but a local database. "Poka" and "Marina" are FABRIC names (trade names of cloth);
// product names are separate, deliberately placeholder-looking ("Contoh Gamis A/B/C") so nobody
// mistakes them for real catalog entries, and so a fabric name can never leak into a product's
// code/SKU prefix (that only ever derives from the product's own name — see ./catalog/codes.ts).
// Colors belong to the FABRIC (fabric_colors), not the product — see docs/SPEC.md.
import { and, eq } from "drizzle-orm";
import { generateSku } from "./catalog/codes";
import { db as defaultDb } from "./client";
import { fabricColors, fabrics, products, productVariants } from "./schema";
import type { FabricPriceUnit, ProductClosure, Size, SizeMode } from "./schema/constants";

type Database = typeof defaultDb;

/** Checks the ACTUAL connection `db` will write through — not `process.env.DATABASE_URL`, which
 * could silently disagree with an explicitly-passed `db` (e.g. a test's own client). `$client`
 * is drizzle-orm's postgres-js driver exposing the underlying `postgres.Sql` instance, whose
 * `.options.host` is the real negotiated host(s) for this connection. */
function assertLocalDatabase(db: Database): void {
  const hosts = db.$client.options.host;
  const isLocal = hosts.every((host) => host === "localhost" || host === "127.0.0.1");
  if (!isLocal) {
    throw new Error(
      `Refusing to run db:seed:dev against non-local host(s) "${hosts.join(", ")}". This script ` +
        `inserts sample data and must never run against a dev/prod database.`,
    );
  }
}

interface FabricSeed {
  name: string;
  supplier: string;
  composition: string;
  priceAmount: number;
  priceUnit: FabricPriceUnit;
  careInstructions: string;
}

interface ColorSeed {
  name: string;
  hex?: string;
  supplierColorCode?: string;
}

// Single-process, developer-run script — a find-then-write here isn't a check-then-write race
// (CLAUDE.md's rule targets concurrent request handling, not a one-off local dev convenience).
// Updates the row if it already exists, rather than only inserting once and leaving it stale —
// so re-running this script after a schema change actually backfills the new fields.
async function upsertFabricByName(db: Database, input: FabricSeed): Promise<string> {
  const [existing] = await db.select({ id: fabrics.id }).from(fabrics).where(eq(fabrics.name, input.name)).limit(1);
  if (existing) {
    await db.update(fabrics).set(input).where(eq(fabrics.id, existing.id));
    return existing.id;
  }
  const [fabric] = await db.insert(fabrics).values(input).returning({ id: fabrics.id });
  if (!fabric) throw new Error(`failed to insert fabric "${input.name}"`);
  return fabric.id;
}

async function upsertFabricColor(db: Database, fabricId: string, input: ColorSeed): Promise<string> {
  const [existing] = await db
    .select({ id: fabricColors.id })
    .from(fabricColors)
    .where(and(eq(fabricColors.fabricId, fabricId), eq(fabricColors.name, input.name)))
    .limit(1);
  const values = { hex: input.hex ?? null, supplierColorCode: input.supplierColorCode ?? null };
  if (existing) {
    await db.update(fabricColors).set(values).where(eq(fabricColors.id, existing.id));
    return existing.id;
  }
  const [color] = await db
    .insert(fabricColors)
    .values({ fabricId, name: input.name, ...values })
    .returning({ id: fabricColors.id });
  if (!color) throw new Error(`failed to insert fabric color "${input.name}"`);
  return color.id;
}

interface VariantSeed {
  colorName: string;
  sizes: readonly Size[];
}

interface ProductSeed {
  name: string;
  code: string;
  slug: string;
  fabricName: string;
  closure: ProductClosure;
  sizeMode: SizeMode;
  basePrice: number;
  variants: readonly VariantSeed[];
}

async function upsertProductWithVariants(
  db: Database,
  fabricIdsByName: Map<string, string>,
  colorIdsByFabricAndName: Map<string, string>,
  seed: ProductSeed,
): Promise<void> {
  const fabricId = fabricIdsByName.get(seed.fabricName);
  if (!fabricId) throw new Error(`fabric "${seed.fabricName}" was not seeded before its products`);

  const [existingProduct] = await db.select({ id: products.id }).from(products).where(eq(products.slug, seed.slug)).limit(1);
  const productId =
    existingProduct?.id ??
    (
      await db
        .insert(products)
        .values({
          name: seed.name,
          code: seed.code,
          slug: seed.slug,
          fabricId,
          closure: seed.closure,
          sizeMode: seed.sizeMode,
          basePrice: seed.basePrice,
        })
        .returning({ id: products.id })
    )[0]?.id;
  if (!productId) throw new Error(`failed to upsert product "${seed.name}"`);

  const rows = seed.variants.flatMap((variant) => {
    const fabricColorId = colorIdsByFabricAndName.get(`${seed.fabricName}:${variant.colorName}`);
    if (!fabricColorId) {
      throw new Error(`color "${variant.colorName}" was not seeded on fabric "${seed.fabricName}"`);
    }
    return variant.sizes.map((size) => ({
      sku: generateSku({ code: seed.code, closure: seed.closure, color: variant.colorName, size }),
      productId,
      fabricId,
      fabricColorId,
      closure: seed.closure,
      size,
    }));
  });
  if (rows.length > 0) {
    await db.insert(productVariants).values(rows).onConflictDoNothing({ target: productVariants.sku });
  }
}

export async function seedDev(db: Database = defaultDb): Promise<void> {
  assertLocalDatabase(db);

  const fabricIdsByName = new Map<string, string>();
  fabricIdsByName.set(
    "Poka",
    await upsertFabricByName(db, {
      name: "Poka",
      supplier: "Laksmi, Pasar Baru",
      composition: "polyester + rayon",
      priceAmount: 85_000,
      priceUnit: "yard",
      careInstructions: "Cuci dengan air dingin, jangan diperas, setrika suhu rendah.",
    }),
  );
  fabricIdsByName.set(
    "Marina",
    await upsertFabricByName(db, {
      name: "Marina",
      supplier: "Sinar Textile",
      composition: "polyester + rayon",
      priceAmount: 75_000,
      priceUnit: "meter",
      careInstructions: "Cuci dengan tangan atau mesin siklus lembut, hindari pemutih.",
    }),
  );

  // "Dusty Pink" has no hex on purpose — exercises the neutral placeholder swatch in the UI.
  const colorIdsByFabricAndName = new Map<string, string>();
  for (const [fabricName, colors] of [
    ["Poka", [{ name: "Sage", hex: "#9CAF88" }, { name: "Mocca", hex: "#8B6B4E" }]],
    ["Marina", [{ name: "Navy", hex: "#1F2A44" }, { name: "Dusty Pink" }]],
  ] as const) {
    const fabricId = fabricIdsByName.get(fabricName);
    if (!fabricId) throw new Error(`fabric "${fabricName}" was not seeded before its colors`);
    for (const color of colors) {
      colorIdsByFabricAndName.set(`${fabricName}:${color.name}`, await upsertFabricColor(db, fabricId, color));
    }
  }

  await upsertProductWithVariants(db, fabricIdsByName, colorIdsByFabricAndName, {
    name: "Contoh Gamis A",
    code: "CONTOHGAMISA",
    slug: "contoh-gamis-a",
    fabricName: "Poka",
    closure: "front_zip",
    sizeMode: "sized",
    basePrice: 269_000,
    variants: [
      { colorName: "Sage", sizes: ["S", "M", "L"] },
      { colorName: "Mocca", sizes: ["S", "M", "L"] },
    ],
  });

  await upsertProductWithVariants(db, fabricIdsByName, colorIdsByFabricAndName, {
    name: "Contoh Gamis B",
    code: "CONTOHGAMISB",
    slug: "contoh-gamis-b",
    fabricName: "Marina",
    closure: "back_zip",
    sizeMode: "sized",
    basePrice: 229_000,
    variants: [
      { colorName: "Navy", sizes: ["S", "M", "L"] },
      { colorName: "Dusty Pink", sizes: ["S", "M", "L"] },
    ],
  });

  await upsertProductWithVariants(db, fabricIdsByName, colorIdsByFabricAndName, {
    name: "Contoh Gamis C",
    code: "CONTOHGAMISC",
    slug: "contoh-gamis-c",
    fabricName: "Poka",
    closure: "front_zip",
    sizeMode: "all_size",
    basePrice: 249_000,
    variants: [
      { colorName: "Sage", sizes: ["ALLSIZE"] },
      { colorName: "Mocca", sizes: ["ALLSIZE"] },
    ],
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  seedDev()
    .then(() => {
      console.log("dev sample data seeded");
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { generateProductCode, generateSlug } from "@ammari/db/catalog";
import { auditLog } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { createFabric } from "@/lib/products/fabric-queries";
import { createProduct, listProducts, updateProduct } from "@/lib/products/queries";
import {
  createProductType,
  getProductTypeByCode,
  listActiveProductTypeOptions,
  listProductTypeFilterOptions,
  listProductTypes,
  setProductTypeActive,
  updateProductType,
} from "./queries";

const ACTOR_ID = null;

/** Unique per test: code and name are both UNIQUE across the table, and withRollback shares one
 * database with every other test file. */
function uniqueType(label: string) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return { code: `T_${label}_${suffix}`, name: `Jenis ${label} ${suffix}`, sortOrder: 5, isActive: true };
}

async function productFixture(tx: TestTx, productTypeCode: string, namePrefix = "Contoh Gamis") {
  const fabric = await createFabric({ name: `Bahan ${randomUUID().slice(0, 8)}` }, ACTOR_ID, tx);
  const name = `${namePrefix} ${randomUUID().slice(0, 6)}`;
  return createProduct(
    {
      name,
      code: generateProductCode(name),
      slug: generateSlug(name),
      fabricId: fabric.id,
      closure: "front_zip",
      sizeMode: "all_size",
      basePrice: 269_000,
      isActive: true,
      highlights: [],
      productTypeCode,
    },
    ACTOR_ID,
    tx,
  );
}

function updateInputFrom(product: Awaited<ReturnType<typeof productFixture>>, productTypeCode?: string) {
  return {
    name: product.name,
    slug: product.slug,
    fabricId: product.fabricId,
    closure: product.closure,
    basePrice: product.basePrice,
    isActive: product.isActive,
    highlights: product.highlights,
    productTypeCode,
  };
}

describe("product type master", () => {
  test("the DRESS / Gamis reference row exists (migration 0037)", async () => {
    await withRollback(async (tx) => {
      const dress = await getProductTypeByCode("DRESS", tx);
      expect(dress).toMatchObject({ code: "DRESS" });
    });
  });

  test("create, rename, deactivate, reactivate round-trip, each audit logged", async () => {
    await withRollback(async (tx) => {
      const input = uniqueType("KHIMAR");
      const created = await createProductType(input, ACTOR_ID, tx);
      expect(created).toMatchObject(input);

      const renamed = await updateProductType(created.code, { name: `${input.name} Baru`, sortOrder: 2, isActive: true }, ACTOR_ID, tx);
      expect(renamed.name).toBe(`${input.name} Baru`);
      expect(renamed.sortOrder).toBe(2);
      expect(renamed.code).toBe(input.code);

      expect((await setProductTypeActive(created.code, false, ACTOR_ID, tx)).isActive).toBe(false);
      expect((await setProductTypeActive(created.code, true, ACTOR_ID, tx)).isActive).toBe(true);

      const entries = await tx.select().from(auditLog).where(eq(auditLog.entityId, created.code));
      expect(entries.map((entry) => entry.action).sort()).toEqual(["activate", "create", "deactivate", "update"]);
      expect(entries.every((entry) => entry.entityType === "product_type")).toBe(true);
    });
  });

  test("a duplicate code or a case-insensitive duplicate name is a field error, not a raw constraint error", async () => {
    await withRollback(async (tx) => {
      const input = uniqueType("DUP");
      await createProductType(input, ACTOR_ID, tx);
      const sameCode = createProductType({ ...uniqueType("OTHER"), code: input.code }, ACTOR_ID, tx);
      await expect(sameCode).rejects.toBeInstanceOf(FieldError);
      await expect(sameCode).rejects.toMatchObject({ field: "code", message: "Kode jenis produk ini sudah dipakai." });
    });
    await withRollback(async (tx) => {
      const input = uniqueType("DUP");
      await createProductType(input, ACTOR_ID, tx);
      const sameName = createProductType({ ...uniqueType("OTHER"), name: input.name.toUpperCase() }, ACTOR_ID, tx);
      await expect(sameName).rejects.toMatchObject({ field: "name", message: "Nama jenis produk ini sudah dipakai." });
    });
  });

  test("updating or toggling an unknown or malformed code is refused", async () => {
    await withRollback(async (tx) => {
      await expect(updateProductType("NOPE_NOT_THERE", { name: "x", sortOrder: 0, isActive: true }, ACTOR_ID, tx)).rejects.toThrow(
        "Jenis produk tidak ditemukan.",
      );
      await expect(setProductTypeActive("lowercase", false, ACTOR_ID, tx)).rejects.toThrow("Jenis produk tidak ditemukan.");
      expect(await getProductTypeByCode("lowercase", tx)).toBeNull();
    });
  });

  test("the picker offers active types only; the filter and the list include inactive ones, with product counts", async () => {
    await withRollback(async (tx) => {
      const active = await createProductType(uniqueType("ACT"), ACTOR_ID, tx);
      const inactive = await createProductType({ ...uniqueType("OFF"), isActive: false }, ACTOR_ID, tx);
      await productFixture(tx, active.code);
      await productFixture(tx, active.code);

      const pickerCodes = (await listActiveProductTypeOptions(tx)).map((option) => option.code);
      expect(pickerCodes).toContain(active.code);
      expect(pickerCodes).not.toContain(inactive.code);

      const filterCodes = (await listProductTypeFilterOptions(tx)).map((option) => option.code);
      expect(filterCodes).toEqual(expect.arrayContaining([active.code, inactive.code]));
      // Inactive types sort after every active one.
      expect(filterCodes.indexOf(inactive.code)).toBeGreaterThan(filterCodes.indexOf(active.code));

      const rows = await listProductTypes(tx);
      expect(rows.find((row) => row.code === active.code)?.productCount).toBe(2);
      expect(rows.find((row) => row.code === inactive.code)?.productCount).toBe(0);
    });
  });
});

describe("products and their type", () => {
  test("createProduct stores the chosen type", async () => {
    await withRollback(async (tx) => {
      const type = await createProductType(uniqueType("NEW"), ACTOR_ID, tx);
      const product = await productFixture(tx, type.code);
      expect(product.productTypeCode).toBe(type.code);
    });
  });

  test("createProduct refuses an inactive or unknown type as a field error", async () => {
    await withRollback(async (tx) => {
      const type = await createProductType({ ...uniqueType("OFF"), isActive: false }, ACTOR_ID, tx);
      await expect(productFixture(tx, type.code)).rejects.toMatchObject({
        field: "productTypeCode",
        message: `Jenis produk "${type.name}" sudah dinonaktifkan dan tidak bisa dipilih lagi.`,
      });
    });
    await withRollback(async (tx) => {
      await expect(productFixture(tx, "NOT_A_TYPE_ZZ")).rejects.toMatchObject({ field: "productTypeCode", message: "Jenis produk tidak ditemukan." });
    });
  });

  test("updateProduct: changing to an inactive type is refused; keeping a since-deactivated type is allowed", async () => {
    await withRollback(async (tx) => {
      const original = await createProductType(uniqueType("ORIG"), ACTOR_ID, tx);
      const other = await createProductType(uniqueType("OTHER"), ACTOR_ID, tx);
      const product = await productFixture(tx, original.code);

      await setProductTypeActive(original.code, false, ACTOR_ID, tx);
      await setProductTypeActive(other.code, false, ACTOR_ID, tx);

      // Re-saving with its own (now inactive) type, and with the field left out, both work.
      const kept = await updateProduct(product.id, { ...updateInputFrom(product, original.code), basePrice: 279_000 }, ACTOR_ID, tx);
      expect(kept.productTypeCode).toBe(original.code);
      const untouched = await updateProduct(product.id, updateInputFrom(kept), ACTOR_ID, tx);
      expect(untouched.productTypeCode).toBe(original.code);

      await expect(updateProduct(product.id, updateInputFrom(kept, other.code), ACTOR_ID, tx)).rejects.toMatchObject({
        field: "productTypeCode",
      });

      await setProductTypeActive(other.code, true, ACTOR_ID, tx);
      const changed = await updateProduct(product.id, updateInputFrom(kept, other.code), ACTOR_ID, tx);
      expect(changed.productTypeCode).toBe(other.code);
    });
  });

  test("listProducts filters by type and returns the type's name and active state", async () => {
    await withRollback(async (tx) => {
      const prefix = `Contoh Gamis Jenis ${randomUUID().slice(0, 6)}`;
      const typeA = await createProductType(uniqueType("A"), ACTOR_ID, tx);
      const typeB = await createProductType(uniqueType("B"), ACTOR_ID, tx);
      const inA = await productFixture(tx, typeA.code, prefix);
      const inB = await productFixture(tx, typeB.code, prefix);
      await setProductTypeActive(typeB.code, false, ACTOR_ID, tx);

      const all = await listProducts({ q: prefix }, "1", "100", tx);
      expect(all.rows.map((row) => row.id).sort()).toEqual([inA.id, inB.id].sort());

      const onlyA = await listProducts({ q: prefix, productTypeCode: typeA.code }, "1", "100", tx);
      expect(onlyA.rows.map((row) => row.id)).toEqual([inA.id]);
      expect(onlyA.rows[0]).toMatchObject({ productTypeCode: typeA.code, productTypeName: typeA.name, productTypeIsActive: true });

      const onlyB = await listProducts({ q: prefix, productTypeCode: typeB.code }, "1", "100", tx);
      expect(onlyB.rows.map((row) => row.id)).toEqual([inB.id]);
      expect(onlyB.rows[0]?.productTypeIsActive).toBe(false);
      expect(onlyB.pagination.totalCount).toBe(1);
    });
  });
});

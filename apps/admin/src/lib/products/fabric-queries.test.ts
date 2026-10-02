import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { auditLog, fabrics } from "@ammari/db/schema";
import { eq } from "drizzle-orm";
import { ActionError, FieldError } from "./errors";
import {
  createFabric,
  createFabricColor,
  createFabricWithColors,
  deleteFabric,
  deleteFabricColor,
  listFabricColors,
  listFabricsWithUsage,
  updateFabricColor,
} from "./fabric-queries";
import { generateProductCode, generateSlug } from "@ammari/db/catalog";
import { addVariants, createProduct } from "./queries";

const ACTOR_ID = null;

async function createFabricFixture(tx: TestTx, overrides: Partial<Parameters<typeof createFabric>[0]> = {}) {
  return createFabric({ name: `Bahan ${randomUUID().slice(0, 8)}`, ...overrides }, ACTOR_ID, tx);
}

async function createProductFixture(tx: TestTx, fabricId: string) {
  const name = `Contoh Gamis ${randomUUID().slice(0, 6)}`;
  return createProduct(
    {
      name,
      code: generateProductCode(name),
      slug: generateSlug(name),
      fabricId,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 269_000,
      isActive: true,
    },
    ACTOR_ID,
    tx,
  );
}

describe("deleteFabric", () => {
  test("refuses to delete a fabric used by a product, and says why", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      await createProductFixture(tx, fabric.id);
      try {
        await deleteFabric(fabric.id, ACTOR_ID, tx);
        throw new Error("expected deleteFabric to reject a used fabric");
      } catch (error) {
        expect(error).toBeInstanceOf(ActionError);
        expect((error as ActionError).message).toMatch(/masih dipakai/);
      }
    });
  });

  test("deletes an unused fabric", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      await expect(deleteFabric(fabric.id, ACTOR_ID, tx)).resolves.not.toThrow();
    });
  });
});

describe("createFabricColor", () => {
  test("a duplicate color name on the same fabric surfaces as a field error on 'name'", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      await createFabricColor(fabric.id, { name: "Sage" }, ACTOR_ID, tx);
      try {
        await createFabricColor(fabric.id, { name: "sage" }, ACTOR_ID, tx);
        throw new Error("expected createFabricColor to reject a duplicate name");
      } catch (error) {
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).field).toBe("name");
      }
    });
  });

  test("normalizes a lowercase/no-# hex to uppercase '#RRGGBB'", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColor(fabric.id, { name: "Sage", hex: "9caf88" }, ACTOR_ID, tx);
      expect(color.hex).toBe("#9CAF88");
    });
  });

  test("rejects an invalid hex with a friendly FieldError", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      await expect(createFabricColor(fabric.id, { name: "Sage", hex: "not-a-hex" }, ACTOR_ID, tx)).rejects.toThrow(
        FieldError,
      );
    });
  });
});

describe("createFabricWithColors", () => {
  test("creates a fabric and 2 colors in one call, with exactly one audit_log entry", async () => {
    await withRollback(async (tx) => {
      const { fabric, colors } = await createFabricWithColors(
        { name: `Bahan ${randomUUID().slice(0, 8)}` },
        [
          { name: "Sage", hex: "#9CAF88" },
          { name: "Mocca", supplierColorCode: "No. 12" },
        ],
        ACTOR_ID,
        tx,
      );

      expect(colors).toHaveLength(2);
      expect(colors.map((c) => c.name).sort()).toEqual(["Mocca", "Sage"]);
      const stored = await listFabricColors(fabric.id, {}, tx);
      expect(stored).toHaveLength(2);

      const entries = await tx.select().from(auditLog).where(eq(auditLog.entityType, "fabric"));
      const ownEntries = entries.filter((row) => row.entityId === fabric.id);
      expect(ownEntries).toHaveLength(1);
    });
  });

  test("a duplicate color name in the same submission (case-insensitive) is rejected and NOTHING is saved", async () => {
    await withRollback(async (tx) => {
      const name = `Bahan ${randomUUID().slice(0, 8)}`;
      try {
        await createFabricWithColors(
          { name },
          [{ name: "Sage" }, { name: "sage" }],
          ACTOR_ID,
          tx,
        );
        throw new Error("expected createFabricWithColors to reject a duplicate color name");
      } catch (error) {
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).field).toBe("colors.1.name");
      }

      // Not just the colors — the fabric itself must not exist either (all-or-nothing).
      const [row] = await tx.select().from(fabrics).where(eq(fabrics.name, name));
      expect(row).toBeUndefined();
    });
  });

  test("rows that are completely blank are silently ignored", async () => {
    await withRollback(async (tx) => {
      const { fabric, colors } = await createFabricWithColors(
        { name: `Bahan ${randomUUID().slice(0, 8)}` },
        [{ name: "Sage" }, { name: "", supplierColorCode: "", hex: "" }],
        ACTOR_ID,
        tx,
      );
      expect(colors).toHaveLength(1);
      expect(colors[0]?.name).toBe("Sage");
      expect(fabric).toBeDefined();
    });
  });

  test("a row with some input but a blank name is a FieldError on that row's name, not a silent drop", async () => {
    await withRollback(async (tx) => {
      await expect(
        createFabricWithColors(
          { name: `Bahan ${randomUUID().slice(0, 8)}` },
          [{ name: "", hex: "#9CAF88" }],
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "colors.0.name" });
    });
  });

  test("an invalid hex on a color row is a FieldError on that row's hex field", async () => {
    await withRollback(async (tx) => {
      await expect(
        createFabricWithColors(
          { name: `Bahan ${randomUUID().slice(0, 8)}` },
          [{ name: "Sage", hex: "not-a-hex" }],
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "colors.0.hex" });
    });
  });

  test("creating a fabric with no colors works as before", async () => {
    await withRollback(async (tx) => {
      const { fabric, colors } = await createFabricWithColors(
        { name: `Bahan ${randomUUID().slice(0, 8)}` },
        [],
        ACTOR_ID,
        tx,
      );
      expect(colors).toHaveLength(0);
      expect(fabric).toBeDefined();
    });
  });
});

describe("updateFabricColor", () => {
  test("renaming a color is allowed even when it's already used by a variant", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColor(fabric.id, { name: "Sage" }, ACTOR_ID, tx);
      const product = await createProductFixture(tx, fabric.id);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

      const renamed = await updateFabricColor(color.id, { name: "Forest Green" }, ACTOR_ID, tx);
      expect(renamed.name).toBe("Forest Green");
    });
  });
});

describe("deleteFabricColor", () => {
  test("a color used by a variant cannot be deleted, and says why", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColor(fabric.id, { name: "Sage" }, ACTOR_ID, tx);
      const product = await createProductFixture(tx, fabric.id);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

      try {
        await deleteFabricColor(color.id, ACTOR_ID, tx);
        throw new Error("expected deleteFabricColor to reject a used color");
      } catch (error) {
        expect(error).toBeInstanceOf(ActionError);
        expect((error as ActionError).message).toMatch(/masih dipakai/);
      }
    });
  });

  test("an unused color can be deleted", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColor(fabric.id, { name: "Sage" }, ACTOR_ID, tx);
      await expect(deleteFabricColor(color.id, ACTOR_ID, tx)).resolves.not.toThrow();
    });
  });
});

describe("listFabricsWithUsage pagination", () => {
  test("page 2 shows different fabrics than page 1, with a correct total count", async () => {
    await withRollback(async (tx) => {
      const prefix = `Zzz-Pagination-${randomUUID().slice(0, 6)}`;
      for (let i = 0; i < 21; i += 1) {
        await createFabricFixture(tx, { name: `${prefix} ${String(i).padStart(2, "0")}` });
      }

      const page1 = await listFabricsWithUsage(prefix, "1", tx);
      const page2 = await listFabricsWithUsage(prefix, "2", tx);

      expect(page1.pagination.totalCount).toBe(21);
      expect(page1.pagination.totalPages).toBe(2);
      expect(page1.rows).toHaveLength(20);
      expect(page2.rows).toHaveLength(1);
      expect(page1.rows[0]?.id).not.toBe(page2.rows[0]?.id);
    });
  });
});

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { DEFAULT_EXPENSE_CATEGORIES, auditLog, expenseCategories } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import {
  createExpenseCategory,
  createExpenseItem,
  expenseCategoryCodeBase,
  getExpenseCategoryCatalog,
  getSelectableExpenseCategoryAndItem,
  listExpenseCategories,
  listExpenseItems,
  lockSelectableExpenseCategoryAndItem,
  setExpenseCategoryActive,
  setExpenseItemActive,
  updateExpenseCategory,
  updateExpenseItem,
} from "./queries";

// docs/plans/expense-master-data.md §3.5, session S2: the catalog every expense figure reads, the
// category and item writes, and the lock a new expense takes. Names are UNIQUE across the table,
// so every fixture name carries a random suffix.

const suffix = () => randomUUID().slice(0, 8);

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

async function auditOf(tx: TestDatabase, entityType: string, entityId: string) {
  return tx
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
}

describe("getExpenseCategoryCatalog", () => {
  test("the ten seeded categories (migration 0048) in display order, with their kinds and fixed channels", async () => {
    await withRollback(async (tx) => {
      const { categories } = await getExpenseCategoryCatalog(tx);
      const seeded = categories.filter((category) => DEFAULT_EXPENSE_CATEGORIES.some((entry) => entry.code === category.code));
      expect(seeded).toEqual(DEFAULT_EXPENSE_CATEGORIES.map((category) => ({ ...category, isActive: true })));
    });
  });

  test("lists inactive categories but only active items", async () => {
    await withRollback(async (tx) => {
      const category = await createExpenseCategory({ name: `Langganan ${suffix()}`, kind: "operating", sortOrder: 160 }, null, tx);
      const vps = await createExpenseItem(category.code, { name: "VPS", defaultAmount: 150_000, sortOrder: 1 }, null, tx);
      const claude = await createExpenseItem(category.code, { name: "Claude", sortOrder: 2 }, null, tx);
      await setExpenseItemActive(claude.id, false, null, tx);
      await setExpenseCategoryActive(category.code, false, null, tx);

      const catalog = await getExpenseCategoryCatalog(tx);
      expect(catalog.categories.find((entry) => entry.code === category.code)).toMatchObject({ isActive: false, kind: "operating", isSystem: false });
      expect(catalog.items.filter((item) => item.categoryCode === category.code)).toEqual([
        { id: vps.id, categoryCode: category.code, name: "VPS", note: null, defaultAmount: 150_000, sortOrder: 1 },
      ]);
    });
  });
});

describe("categories", () => {
  test("the code is generated from the name, suffixed on a clash, and every write is audited", async () => {
    expect(expenseCategoryCodeBase("Langganan & Tools")).toBe("langganan_tools");
    expect(expenseCategoryCodeBase("  Ongkos Jahit Ékstra ")).toBe("ongkos_jahit_ekstra");
    expect(expenseCategoryCodeBase("2024 Pajak")).toBe("k_2024_pajak");
    expect(expenseCategoryCodeBase("!!!")).toBe("k");
    expect(expenseCategoryCodeBase("x".repeat(80))).toHaveLength(36);

    await withRollback(async (tx) => {
      const tag = suffix().replace(/-/g, "");
      const first = await createExpenseCategory({ name: `Pajak ${tag}`, kind: "operating", sortOrder: 170 }, null, tx);
      expect(first).toMatchObject({ code: `pajak_${tag}`, kind: "operating", isSystem: false, isActive: true, fixedChannelId: null });
      // Same code base, different name: the next free suffix.
      const second = await createExpenseCategory({ name: `Pajak-${tag}`, kind: "operating", sortOrder: 171 }, null, tx);
      expect(second.code).toBe(`pajak_${tag}_2`);

      const renamed = await updateExpenseCategory(first.code, { name: `Pajak Daerah ${tag}`, sortOrder: 5 }, null, tx);
      expect(renamed).toMatchObject({ code: first.code, name: `Pajak Daerah ${tag}`, sortOrder: 5, kind: "operating" });
      await setExpenseCategoryActive(first.code, false, null, tx);
      await setExpenseCategoryActive(first.code, true, null, tx);
      expect((await auditOf(tx, "expense_category", first.code)).map((row) => row.action).sort()).toEqual(["activate", "create", "deactivate", "update"]);

      const listed = (await listExpenseCategories(tx)).find((row) => row.code === first.code);
      expect(listed).toMatchObject({ itemCount: 0, expenseCount: 0 });
    });
  });

  test("a taken name (case-insensitive) and the reserved name are field errors", async () => {
    await withRollback(async (tx) => {
      const name = `Langganan ${suffix()}`;
      await createExpenseCategory({ name, kind: "operating", sortOrder: 1 }, null, tx);
      const taken = await rejection(createExpenseCategory({ name: name.toUpperCase(), kind: "operating", sortOrder: 1 }, null, tx));
      expect(taken).toBeInstanceOf(FieldError);
      expect(taken).toMatchObject({ field: "name", message: "Nama kategori ini sudah dipakai." });
      for (const reserved of ["Biaya produksi", "  biaya   PRODUKSI "]) {
        expect(await rejection(createExpenseCategory({ name: reserved, kind: "operating", sortOrder: 1 }, null, tx))).toMatchObject({ field: "name" });
      }
      expect(await rejection(createExpenseCategory({ name: " ", kind: "operating", sortOrder: 1 }, null, tx))).toMatchObject({ field: "name" });
      expect(await rejection(createExpenseCategory({ name: "Hadiah", kind: "gift" as never, sortOrder: 1 }, null, tx))).toMatchObject({ field: "kind" });
    });
  });

  test("a system category cannot be deactivated; a missing one is not found", async () => {
    await withRollback(async (tx) => {
      for (const code of ["ads_meta", "ads_shopee", "endorsement", "other"]) {
        const error = await rejection(setExpenseCategoryActive(code, false, null, tx));
        expect(error).toBeInstanceOf(ActionError);
        expect(error.message).toMatch(/tidak bisa dinonaktifkan/);
      }
      // A non-system seeded category can be.
      expect(await setExpenseCategoryActive("packaging", false, null, tx)).toMatchObject({ isActive: false });
      expect(await rejection(updateExpenseCategory("nope_nope", { name: "X", sortOrder: 0 }, null, tx))).toBeInstanceOf(ActionError);
      const [other] = await tx.select().from(expenseCategories).where(eq(expenseCategories.code, "other"));
      expect(other).toMatchObject({ isActive: true });
    });
  });
});

describe("items", () => {
  test("create, edit, deactivate; names are unique per category only", async () => {
    await withRollback(async (tx) => {
      const a = await createExpenseCategory({ name: `Langganan ${suffix()}`, kind: "operating", sortOrder: 1 }, null, tx);
      const b = await createExpenseCategory({ name: `Software ${suffix()}`, kind: "operating", sortOrder: 2 }, null, tx);
      const item = await createExpenseItem(a.code, { name: " Biteship  Grow ", note: " paket bulanan ", sortOrder: 1 }, null, tx);
      expect(item).toMatchObject({ categoryCode: a.code, name: "Biteship Grow", note: "paket bulanan", defaultAmount: null, isActive: true });
      // Same name in another category is fine; in the same category (any case) it is not.
      await createExpenseItem(b.code, { name: "Biteship Grow", sortOrder: 1 }, null, tx);
      expect(await rejection(createExpenseItem(a.code, { name: "biteship grow", sortOrder: 2 }, null, tx))).toMatchObject({
        field: "name",
        message: "Nama sudah dipakai di kategori ini.",
      });
      expect(await rejection(createExpenseItem(a.code, { name: "VPS", defaultAmount: 0, sortOrder: 2 }, null, tx))).toMatchObject({ field: "defaultAmount" });
      expect(await rejection(createExpenseItem("tidak_ada", { name: "VPS", sortOrder: 2 }, null, tx))).toBeInstanceOf(ActionError);

      const edited = await updateExpenseItem(item.id, { name: "Biteship", note: null, defaultAmount: 99_000, sortOrder: 3 }, null, tx);
      expect(edited).toMatchObject({ name: "Biteship", note: null, defaultAmount: 99_000, sortOrder: 3, categoryCode: a.code });
      await setExpenseItemActive(item.id, false, null, tx);
      expect(await listExpenseItems(a.code, tx)).toEqual([expect.objectContaining({ id: item.id, isActive: false, expenseCount: 0 })]);
      expect((await auditOf(tx, "expense_item", item.id)).map((row) => row.action).sort()).toEqual(["create", "deactivate", "update"]);
      expect((await listExpenseCategories(tx)).find((row) => row.code === a.code)).toMatchObject({ itemCount: 1 });
    });
  });
});

describe("selecting a category for a NEW expense", () => {
  test("an active category (and its active item) is selectable; inactive, unknown or another category's item is refused", async () => {
    await withRollback(async (tx) => {
      const category = await createExpenseCategory({ name: `Langganan ${suffix()}`, kind: "operating", sortOrder: 1 }, null, tx);
      const other = await createExpenseCategory({ name: `Software ${suffix()}`, kind: "operating", sortOrder: 2 }, null, tx);
      const vps = await createExpenseItem(category.code, { name: "VPS", sortOrder: 1 }, null, tx);
      const foreign = await createExpenseItem(other.code, { name: "Figma", sortOrder: 1 }, null, tx);

      expect(await lockSelectableExpenseCategoryAndItem(tx, "ads_tiktok", null)).toEqual({
        category: expect.objectContaining({ code: "ads_tiktok", kind: "ad", fixedChannelId: "tiktok" }),
        item: null,
      });
      expect(await lockSelectableExpenseCategoryAndItem(tx, category.code, vps.id)).toMatchObject({ item: { id: vps.id, name: "VPS" } });
      expect(await rejection(lockSelectableExpenseCategoryAndItem(tx, category.code, foreign.id))).toMatchObject({ field: "itemId" });
      expect(await rejection(lockSelectableExpenseCategoryAndItem(tx, category.code, "not-a-uuid"))).toMatchObject({ field: "itemId" });
      expect(await rejection(lockSelectableExpenseCategoryAndItem(tx, "hadiah", null))).toMatchObject({ field: "category", message: "Pilih kategori." });
      // Session S4: a category with active items needs one, in the lock and in the plain pre-check.
      expect(await rejection(lockSelectableExpenseCategoryAndItem(tx, category.code, null))).toMatchObject({ field: "itemId", message: "Pilih item biaya." });
      expect(await rejection(getSelectableExpenseCategoryAndItem(category.code, null, tx))).toMatchObject({ field: "itemId", message: "Pilih item biaya." });
      expect(await rejection(getSelectableExpenseCategoryAndItem(category.code, foreign.id, tx))).toMatchObject({ field: "itemId" });
      expect(await getSelectableExpenseCategoryAndItem(category.code, vps.id, tx)).toMatchObject({ category: { code: category.code }, item: { id: vps.id, name: "VPS" } });

      await setExpenseItemActive(vps.id, false, null, tx);
      expect(await rejection(lockSelectableExpenseCategoryAndItem(tx, category.code, vps.id))).toMatchObject({ field: "itemId", message: expect.stringMatching(/dinonaktifkan/) });

      await setExpenseCategoryActive(category.code, false, null, tx);
      expect(await rejection(lockSelectableExpenseCategoryAndItem(tx, category.code, null))).toMatchObject({ field: "category", message: expect.stringMatching(/dinonaktifkan/) });
      expect(await rejection(getSelectableExpenseCategoryAndItem(category.code, null, tx))).toMatchObject({ field: "category", message: expect.stringMatching(/dinonaktifkan/) });
      expect((await getSelectableExpenseCategoryAndItem("salary", null, tx)).category).toMatchObject({ code: "salary", kind: "operating", fixedChannelId: null });
    });
  });
});

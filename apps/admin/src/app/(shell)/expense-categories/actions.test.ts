import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { auditLog, expenseCategories, expenseItems } from "@ammari/db/schema";

// docs/plans/expense-master-data.md session S3: the "Kategori Biaya" server actions. The actions
// call the queries with the app's `defaultDb`; here that binding points at the current
// `withRollback` transaction on `ammari_test` (never `ammari`), so every write is rolled back.

const { getStaffSessionMock, dbHolder } = vi.hoisted(() => ({
  getStaffSessionMock: vi.fn(),
  dbHolder: { db: undefined as unknown },
}));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    get defaultDb() {
      if (!dbHolder.db) throw new Error("test: no transaction bound; wrap the test in inTx()");
      return dbHolder.db;
    },
  };
});

const {
  createExpenseCategoryAction,
  createExpenseItemAction,
  setExpenseCategoryActiveAction,
  setExpenseItemActiveAction,
  updateExpenseCategoryAction,
  updateExpenseItemAction,
} = await import("./actions");

const EXPENSE_KEYS = ["ads_expenses.manage", "finance.view_profit"];
const suffix = () => randomUUID().slice(0, 8);

function sessionWithPermissions(permissionKeys: string[], id: string | null = null) {
  return {
    staffUser: { id, name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

function asFinance() {
  getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(EXPENSE_KEYS));
}

async function inTx(fn: (tx: TestDatabase) => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    dbHolder.db = tx;
    try {
      await fn(tx);
    } finally {
      dbHolder.db = undefined;
    }
  });
}

async function auditActions(tx: TestDatabase, entityType: string, entityId: string) {
  const rows = await tx
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
  return rows.map((row) => row.action).sort();
}

async function createCategory(name: string) {
  asFinance();
  const result = await createExpenseCategoryAction({ name, kind: "operating", sortOrder: 160 });
  if (!result.ok) throw new Error(`fixture: ${result.error}`);
  return result.data.code;
}

describe("Kategori Biaya actions require ads_expenses.manage AND finance.view_profit (D5)", () => {
  // Refused before any query runs, so no transaction is needed.
  const calls: [string, () => Promise<unknown>][] = [
    ["createExpenseCategoryAction", () => createExpenseCategoryAction({ name: "Langganan", kind: "operating" })],
    ["updateExpenseCategoryAction", () => updateExpenseCategoryAction("other", { name: "Lainnya", sortOrder: 990 })],
    ["setExpenseCategoryActiveAction", () => setExpenseCategoryActiveAction({ code: "packaging", isActive: false })],
    ["createExpenseItemAction", () => createExpenseItemAction("packaging", { name: "Lakban" })],
    ["updateExpenseItemAction", () => updateExpenseItemAction(randomUUID(), { name: "Lakban", sortOrder: 0 })],
    ["setExpenseItemActiveAction", () => setExpenseItemActiveAction({ id: randomUUID(), isActive: false })],
  ];

  for (const [name, call] of calls) {
    test(`${name} rejects a session with only one of the two keys, or neither`, async () => {
      for (const keys of [["ads_expenses.manage"], ["finance.view_profit"], ["orders.view"]]) {
        getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(keys));
        // forbidden()'s own error (outside a Next server it throws "`forbidden()` is
        // experimental..."), not any rejection: an unbound defaultDb would also reject.
        await expect(call()).rejects.toThrow(/forbidden\(\)/);
      }
    });
  }

  test("an unauthenticated session redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(createExpenseCategoryAction({ name: "Langganan", kind: "operating" })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });
});

describe("categories", () => {
  test("create generates the code, writes an audit row, and refuses a taken name as a field error", async () => {
    await inTx(async (tx) => {
      const name = `Langganan ${suffix()}`;
      const code = await createCategory(name);
      expect(code).toMatch(/^langganan_[a-z0-9_]+$/);
      expect(await auditActions(tx, "expense_category", code)).toEqual(["create"]);

      asFinance();
      // citext: a different case is the same name.
      await expect(createExpenseCategoryAction({ name: name.toUpperCase(), kind: "operating" })).resolves.toEqual({
        ok: false,
        error: "Nama kategori ini sudah dipakai.",
        fieldErrors: { name: "Nama kategori ini sudah dipakai." },
      });
    });
  });

  test('the reserved name "Biaya produksi" is refused with an Indonesian field error, in any case/spacing', async () => {
    await inTx(async () => {
      for (const name of ["Biaya produksi", "  biaya   PRODUKSI "]) {
        asFinance();
        const result = await createExpenseCategoryAction({ name, kind: "operating" });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.fieldErrors?.name).toBe('"Biaya produksi" dipakai untuk pengeluaran produksi dan tidak bisa jadi nama kategori.');
      }
      // A rename into it is refused too.
      asFinance();
      const renamed = await updateExpenseCategoryAction("packaging", { name: "Biaya Produksi", sortOrder: 120 });
      expect(renamed.ok).toBe(false);
      if (!renamed.ok) expect(renamed.fieldErrors).toHaveProperty("name");
    });
  });

  test("an unknown kind, a blank name and a bad sort order are refused before any write", async () => {
    asFinance();
    const badKind = await createExpenseCategoryAction({ name: "Langganan", kind: "salary" as never });
    expect(badKind).toMatchObject({ ok: false, fieldErrors: { kind: "Pilih jenis: Iklan, Endorse, atau Operasional." } });
    asFinance();
    expect(await createExpenseCategoryAction({ name: "Langganan", kind: "operating", sortOrder: -1 })).toMatchObject({ ok: false, fieldErrors: { sortOrder: expect.any(String) } });
    await inTx(async () => {
      asFinance();
      expect(await createExpenseCategoryAction({ name: "   ", kind: "operating" })).toMatchObject({ ok: false, fieldErrors: { name: "Nama kategori wajib diisi." } });
    });
  });

  test("rename keeps code and kind and is audited; deactivate/activate a non-system one is audited", async () => {
    await inTx(async (tx) => {
      const code = await createCategory(`Langganan ${suffix()}`);
      const renamed = `Langganan Tools ${suffix()}`;
      asFinance();
      await expect(updateExpenseCategoryAction(code, { name: renamed, sortOrder: 5 })).resolves.toEqual({ ok: true, data: { code } });
      asFinance();
      await expect(setExpenseCategoryActiveAction({ code, isActive: false })).resolves.toEqual({ ok: true, data: undefined });
      asFinance();
      await expect(setExpenseCategoryActiveAction({ code, isActive: true })).resolves.toEqual({ ok: true, data: undefined });
      expect(await auditActions(tx, "expense_category", code)).toEqual(["activate", "create", "deactivate", "update"]);
      const [stored] = await tx.select().from(expenseCategories).where(eq(expenseCategories.code, code));
      expect(stored).toMatchObject({ name: renamed, sortOrder: 5, kind: "operating", isSystem: false, isActive: true });
    });
  });

  test("a system category cannot be deactivated (friendly error, no audit row) but can be renamed", async () => {
    await inTx(async (tx) => {
      asFinance();
      await expect(setExpenseCategoryActiveAction({ code: "ads_meta", isActive: false })).resolves.toEqual({
        ok: false,
        error: "Kategori sistem dipakai perhitungan ROAS/laporan dan tidak bisa dinonaktifkan.",
      });
      expect(await auditActions(tx, "expense_category", "ads_meta")).toEqual([]);
      asFinance();
      await expect(updateExpenseCategoryAction("ads_meta", { name: `Iklan Meta ${suffix()}`, sortOrder: 10 })).resolves.toMatchObject({ ok: true });
    });
  });

  test("an update without a sort order is refused (never silently reset to 0); odd payloads get Indonesian messages", async () => {
    asFinance();
    expect(await updateExpenseCategoryAction("packaging", { name: "Packaging" } as never)).toMatchObject({ ok: false, fieldErrors: { sortOrder: expect.any(String) } });
    for (const sortOrder of [null, true, [5], "1.5", 10_000]) {
      asFinance();
      expect(await updateExpenseCategoryAction("packaging", { name: "Packaging", sortOrder } as never)).toMatchObject({ ok: false, fieldErrors: { sortOrder: expect.any(String) } });
    }
    asFinance();
    expect(await createExpenseCategoryAction(null as never)).toEqual({ ok: false, error: "Input tidak valid." });
    asFinance();
    expect(await createExpenseItemAction("packaging", { name: "VPS", defaultAmount: 5 } as never)).toMatchObject({ ok: false, fieldErrors: { defaultAmount: expect.any(String) } });
    asFinance();
    expect(await createExpenseItemAction("packaging", { name: "VPS", note: 5 } as never)).toEqual({ ok: false, error: "Input tidak valid.", fieldErrors: { note: "Input tidak valid." } });
  });

  test("an unknown or malformed code is 'not found', never a query error", async () => {
    await inTx(async () => {
      asFinance();
      await expect(updateExpenseCategoryAction("tidak_ada", { name: "X", sortOrder: 0 })).resolves.toEqual({ ok: false, error: "Kategori biaya tidak ditemukan." });
      asFinance();
      await expect(setExpenseCategoryActiveAction({ code: "Not A Code", isActive: false })).resolves.toEqual({ ok: false, error: "Kategori biaya tidak ditemukan." });
      asFinance();
      await expect(createExpenseItemAction("tidak_ada", { name: "VPS" })).resolves.toEqual({ ok: false, error: "Kategori biaya tidak ditemukan." });
    });
  });
});

describe("items", () => {
  test("add with an optional default amount typed as rupiah text, edit, deactivate, reactivate: all audited", async () => {
    await inTx(async (tx) => {
      const code = await createCategory(`Langganan ${suffix()}`);
      asFinance();
      const biteship = await createExpenseItemAction(code, { name: "Biteship Grow", defaultAmount: "149.000", note: "Paket bulanan" });
      expect(biteship.ok).toBe(true);
      if (!biteship.ok) return;
      asFinance();
      const claude = await createExpenseItemAction(code, { name: "Claude", defaultAmount: "" });
      expect(claude.ok).toBe(true);
      if (!claude.ok) return;

      const [stored] = await tx.select().from(expenseItems).where(eq(expenseItems.id, biteship.data.id));
      expect(stored).toMatchObject({ name: "Biteship Grow", defaultAmount: 149_000, note: "Paket bulanan", isActive: true });
      const [noDefault] = await tx.select().from(expenseItems).where(eq(expenseItems.id, claude.data.id));
      expect(noDefault?.defaultAmount).toBeNull();

      asFinance();
      await expect(updateExpenseItemAction(claude.data.id, { name: "Claude Pro", defaultAmount: "Rp 300.000", sortOrder: 2 })).resolves.toEqual({ ok: true, data: undefined });
      asFinance();
      await expect(setExpenseItemActiveAction({ id: claude.data.id, isActive: false })).resolves.toEqual({ ok: true, data: undefined });
      asFinance();
      await expect(setExpenseItemActiveAction({ id: claude.data.id, isActive: true })).resolves.toEqual({ ok: true, data: undefined });

      const [renamed] = await tx.select().from(expenseItems).where(eq(expenseItems.id, claude.data.id));
      expect(renamed).toMatchObject({ name: "Claude Pro", defaultAmount: 300_000, isActive: true });
      expect(await auditActions(tx, "expense_item", claude.data.id)).toEqual(["activate", "create", "deactivate", "update"]);
      expect(await auditActions(tx, "expense_item", biteship.data.id)).toEqual(["create"]);
    });
  });

  test("a taken name in the same category is a field error; another category may reuse it", async () => {
    await inTx(async () => {
      const code = await createCategory(`Langganan ${suffix()}`);
      asFinance();
      expect((await createExpenseItemAction(code, { name: "VPS" })).ok).toBe(true);
      asFinance();
      await expect(createExpenseItemAction(code, { name: "vps" })).resolves.toEqual({
        ok: false,
        error: "Nama sudah dipakai di kategori ini.",
        fieldErrors: { name: "Nama sudah dipakai di kategori ini." },
      });
      asFinance();
      expect((await createExpenseItemAction("packaging", { name: `VPS` })).ok).toBe(true);
    });
  });

  test("renaming an item into a name its category already has is a field error", async () => {
    await inTx(async () => {
      const code = await createCategory(`Langganan ${suffix()}`);
      asFinance();
      expect((await createExpenseItemAction(code, { name: "VPS" })).ok).toBe(true);
      asFinance();
      const claude = await createExpenseItemAction(code, { name: "Claude" });
      if (!claude.ok) throw new Error("fixture");
      asFinance();
      await expect(updateExpenseItemAction(claude.data.id, { name: "VPS", sortOrder: 0 })).resolves.toMatchObject({ ok: false, fieldErrors: { name: "Nama sudah dipakai di kategori ini." } });
    });
  });

  test("an invalid default amount, blank name or unknown item id is refused", async () => {
    await inTx(async () => {
      const code = await createCategory(`Langganan ${suffix()}`);
      for (const defaultAmount of ["abc", "1,5", "-1", "0"]) {
        asFinance();
        const result = await createExpenseItemAction(code, { name: "VPS", defaultAmount });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.fieldErrors).toHaveProperty("defaultAmount");
      }
      asFinance();
      expect(await createExpenseItemAction(code, { name: "  " })).toMatchObject({ ok: false, fieldErrors: { name: "Nama item wajib diisi." } });
      asFinance();
      await expect(updateExpenseItemAction("not-a-uuid", { name: "VPS", sortOrder: 0 })).resolves.toEqual({ ok: false, error: "Item biaya tidak ditemukan." });
      asFinance();
      await expect(setExpenseItemActiveAction({ id: randomUUID(), isActive: false })).resolves.toEqual({ ok: false, error: "Item biaya tidak ditemukan." });
    });
  });
});

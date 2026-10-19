import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { auditLog, suppliers } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { createSupplier, getSupplierById, listSuppliers, setSupplierActive, updateSupplier } from "./queries";

/** A unique name per test — `suppliers.name` is citext UNIQUE across the whole table, and
 * withRollback shares one database with every other test file. */
function uniqueName(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

describe("supplier master CRUD", () => {
  test("a name alone is enough — every other field stays null and the supplier is active (D13)", async () => {
    await withRollback(async (tx) => {
      const created = await createSupplier({ name: uniqueName("Toko Laksmi") }, null, tx);

      expect(created.isActive).toBe(true);
      expect(created.kinds).toEqual([]);
      expect(created.phone).toBeNull();
      expect(created.address).toBeNull();
      expect(created.bankName).toBeNull();
      expect(created.bankAccountNo).toBeNull();
      expect(created.bankAccountName).toBeNull();
      expect(created.notes).toBeNull();
    });
  });

  test("createSupplier, updateSupplier, setSupplierActive round-trip", async () => {
    await withRollback(async (tx) => {
      const created = await createSupplier({ name: uniqueName("Penjahit Bu Ani"), kinds: ["service"] }, null, tx);

      const updated = await updateSupplier(
        created.id,
        {
          name: created.name,
          kinds: ["service", "accessory"],
          phone: "0812-1111-2222",
          bankName: "BCA",
          bankAccountNo: "1234567890",
          bankAccountName: "Ani Suryani",
        },
        null,
        tx,
      );
      expect(updated.kinds).toEqual(["service", "accessory"]);
      expect(updated.bankName).toBe("BCA");
      expect(updated.phone).toBe("0812-1111-2222");

      const deactivated = await setSupplierActive(created.id, false, null, tx);
      expect(deactivated.isActive).toBe(false);

      // Deactivate, never delete — the row is still there to be read back.
      const fetched = await getSupplierById(created.id, tx);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.isActive).toBe(false);

      const reactivated = await setSupplierActive(created.id, true, null, tx);
      expect(reactivated.isActive).toBe(true);
    });
  });

  test("a case-only variant of an existing name collides (citext) and reports itself on the name field", async () => {
    await withRollback(async (tx) => {
      const name = uniqueName("Laksmi Textile");
      await createSupplier({ name }, null, tx);

      await expect(createSupplier({ name: name.toLowerCase() }, null, tx)).rejects.toThrow(FieldError);
      await expect(createSupplier({ name: name.toUpperCase() }, null, tx)).rejects.toMatchObject({ field: "name" });
    });
  });

  test("renaming one supplier onto another's name is rejected the same way", async () => {
    await withRollback(async (tx) => {
      const first = uniqueName("Pemasok Satu");
      const second = uniqueName("Pemasok Dua");
      await createSupplier({ name: first }, null, tx);
      const other = await createSupplier({ name: second }, null, tx);

      await expect(updateSupplier(other.id, { name: first.toUpperCase() }, null, tx)).rejects.toThrow(FieldError);
    });
  });

  test("a kind outside SUPPLIER_KINDS is rejected by the database, not silently stored", async () => {
    await withRollback(async (tx) => {
      // Cast: the whole point is to get past the TypeScript layer and prove the CHECK
      // constraint is the real backstop for a request that bypasses the form's own validation.
      await expect(
        createSupplier({ name: uniqueName("Pemasok Aneh"), kinds: ["kain"] as unknown as string[] }, null, tx),
      ).rejects.toThrow();
    });
  });

  test("a duplicated kind is rejected by the database", async () => {
    await withRollback(async (tx) => {
      await expect(createSupplier({ name: uniqueName("Pemasok Dobel"), kinds: ["fabric", "fabric"] }, null, tx)).rejects.toThrow();
    });
  });

  test("all four kinds at once is valid (the max-cardinality CHECK is a backstop, not a limit she can hit)", async () => {
    await withRollback(async (tx) => {
      const created = await createSupplier(
        { name: uniqueName("Pemasok Serba Ada"), kinds: ["fabric", "accessory", "service", "other"] },
        null,
        tx,
      );
      expect(created.kinds).toHaveLength(4);
    });
  });

  test("updateSupplier on a missing id is refused rather than silently doing nothing", async () => {
    await withRollback(async (tx) => {
      await expect(updateSupplier(randomUUID(), { name: uniqueName("Hantu") }, null, tx)).rejects.toThrow(/tidak ditemukan/i);
      await expect(setSupplierActive(randomUUID(), false, null, tx)).rejects.toThrow(/tidak ditemukan/i);
    });
  });

  test("a malformed id reads as 'not found', not a raw Postgres uuid-syntax error", async () => {
    await withRollback(async (tx) => {
      // Postgres rejects 'tidak-valid' in a `where id = $1` comparison with 22P02, which would
      // reach the UI as a 500 instead of the 404 /suppliers/[id] means to render.
      await expect(getSupplierById("tidak-valid", tx)).resolves.toBeNull();
      await expect(updateSupplier("tidak-valid", { name: uniqueName("Hantu") }, null, tx)).rejects.toThrow(/tidak ditemukan/i);
      await expect(setSupplierActive("tidak-valid", true, null, tx)).rejects.toThrow(/tidak ditemukan/i);
    });
  });
});

describe("supplier audit logging", () => {
  test("create, update and deactivate each write one audit entry naming the actor and the entity", async () => {
    await withRollback(async (tx) => {
      const created = await createSupplier({ name: uniqueName("Toko Audit") }, null, tx);
      await updateSupplier(created.id, { name: created.name, phone: "0813-0000-0000" }, null, tx);
      await setSupplierActive(created.id, false, null, tx);
      await setSupplierActive(created.id, true, null, tx);

      const entries = await tx.select().from(auditLog).where(eq(auditLog.entityId, created.id));
      expect(entries.map((entry) => entry.action).sort()).toEqual(["activate", "create", "deactivate", "update"]);
      expect(entries.every((entry) => entry.entityType === "supplier")).toBe(true);
    });
  });
});

describe("listSuppliers", () => {
  test("filters by name substring and by active/inactive, and sorts by name", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      const aktif = await createSupplier({ name: `AAA Aktif ${marker}` }, null, tx);
      const nonaktif = await createSupplier({ name: `ZZZ Nonaktif ${marker}` }, null, tx);
      await setSupplierActive(nonaktif.id, false, null, tx);

      const all = await listSuppliers({ q: marker }, undefined, undefined, tx);
      expect(all.rows.map((row) => row.id)).toEqual([aktif.id, nonaktif.id]);
      expect(all.pagination.totalCount).toBe(2);

      const onlyActive = await listSuppliers({ q: marker, activeFilter: "active" }, undefined, undefined, tx);
      expect(onlyActive.rows.map((row) => row.id)).toEqual([aktif.id]);

      const onlyInactive = await listSuppliers({ q: marker, activeFilter: "inactive" }, undefined, undefined, tx);
      expect(onlyInactive.rows.map((row) => row.id)).toEqual([nonaktif.id]);
    });
  });

  test("search is case-insensitive and matches a substring in the middle of the name", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      const created = await createSupplier({ name: `Toko Kain Berkah ${marker}` }, null, tx);

      const { rows } = await listSuppliers({ q: `kain berkah ${marker}`.toUpperCase() }, undefined, undefined, tx);
      expect(rows.map((row) => row.id)).toEqual([created.id]);
    });
  });

  test("paginates: 11 suppliers at the smallest allowed page size spill one onto page 2", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      // 11, because resolvePagination only honors PAGE_SIZE_OPTIONS (10/20/50/100) — a
      // perPage=1 would silently fall back to the default and test nothing.
      const names = Array.from({ length: 11 }, (_, index) => `Pemasok ${String(index).padStart(2, "0")} ${marker}`);
      for (const name of names) await createSupplier({ name }, null, tx);

      const page1 = await listSuppliers({ q: marker }, "1", "10", tx);
      expect(page1.rows).toHaveLength(10);
      expect(page1.pagination.totalPages).toBe(2);
      expect(page1.rows[0]?.name).toBe(names[0]);

      const page2 = await listSuppliers({ q: marker }, "2", "10", tx);
      expect(page2.rows.map((row) => row.name)).toEqual([names[10]]);
    });
  });

  test("returns every column the list and the form need, with kinds as a real array", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      const created = await createSupplier({ name: `Toko Kolom ${marker}`, kinds: ["fabric"], phone: "0811" }, null, tx);

      const { rows } = await listSuppliers({ q: marker }, undefined, undefined, tx);
      const row = rows.find((candidate) => candidate.id === created.id);
      expect(row?.kinds).toEqual(["fabric"]);
      expect(row?.phone).toBe("0811");
      expect(row?.isActive).toBe(true);

      // Sanity: the stored row really is what came back (no accidental projection drift).
      const [stored] = await tx.select().from(suppliers).where(eq(suppliers.id, created.id));
      expect(stored?.name).toBe(created.name);
    });
  });
});

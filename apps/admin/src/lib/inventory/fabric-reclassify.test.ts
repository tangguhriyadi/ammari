import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, fabricColors, fabrics, fabricStockMovements } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { getFabricBalance, getFabricColorBalance, reclassifyFabricStock, recordFabricPurchase, voidFabricPurchase } from "./fabric-stock";

// docs/plans/fabric-colour-stock.md S5, D7 / owner decision A3: "Pindahkan ke warna" moves yards
// between two buckets of the same fabric without changing the fabric's total quantity or value.

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx
    .insert(fabrics)
    .values({ name: `Ameera Test ${randomUUID().slice(0, 8)}` })
    .returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

async function stockIn(tx: TestDatabase, fabricId: string, fabricColorId: string, qty: number, valueAmount: number) {
  await tx.insert(fabricStockMovements).values({ fabricId, fabricColorId, qty, valueAmount, type: "purchase", refType: "manual", purchasedAt: "2026-11-01" });
}

describe("reclassifyFabricStock", () => {
  test("Tanpa warna to a colour: an out/in adjustment pair, value moved at the source's average, fabric total unchanged", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const staff = await insertStaffUser(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 13.45, totalAmountPaid: 269_000, purchasedAt: "2026-10-01" }, null, tx); // 20.000/yard
      const totalBefore = await getFabricBalance(fabric.id, tx);

      const { out, in: into } = await reclassifyFabricStock(
        { fabricId: fabric.id, fromColorId: null, toColorId: sage.id, qty: 5, note: "Hitung ulang gudang" },
        staff.id,
        tx,
      );

      expect(out).toMatchObject({ fabricColorId: null, qty: -5, valueAmount: -100_000, type: "adjustment", reason: "other", refType: "manual" });
      expect(into).toMatchObject({ fabricColorId: sage.id, qty: 5, valueAmount: 100_000, type: "adjustment", reason: "other", refType: "manual" });
      expect(out.note).toBe("Pindah ke Sage: Hitung ulang gudang");
      expect(into.note).toBe("Pindah dari Tanpa warna: Hitung ulang gudang");
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 8.45, valueAmount: 169_000 });
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 5, valueAmount: 100_000 });
      expect(await getFabricBalance(fabric.id, tx)).toEqual(totalBefore);

      const entries = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "fabric_stock_movement"), eq(auditLog.entityId, out.id)));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("adjust");
      expect(entries[0]?.after).toMatchObject({
        reason: "Hitung ulang gudang",
        out: { id: out.id, fabricColorId: null, colorName: "Tanpa warna", qty: -5 },
        in: { id: into.id, fabricColorId: sage.id, colorName: "Sage", qty: 5 },
      });
    });
  });

  test("colour to another colour of the same fabric, the whole bucket: zero-residual, exact value moved", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      await stockIn(tx, fabric.id, sage.id, 3, 10); // 3.33/yard: residue on purpose
      await stockIn(tx, fabric.id, mocca.id, 2, 60_000);

      await reclassifyFabricStock({ fabricId: fabric.id, fromColorId: sage.id, toColorId: mocca.id, qty: 3, note: "Salah warna saat terima" }, null, tx);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getFabricColorBalance(fabric.id, mocca.id, tx)).toEqual({ qty: 5, valueAmount: 60_010 });
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 5, valueAmount: 60_010 });
    });
  });

  test("the source can't go below zero, even when the fabric total could cover it", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      await stockIn(tx, fabric.id, sage.id, 2, 40_000);
      await stockIn(tx, fabric.id, mocca.id, 50, 1_000_000);
      await expect(
        reclassifyFabricStock({ fabricId: fabric.id, fromColorId: sage.id, toColorId: mocca.id, qty: 2.5, note: "x" }, null, tx),
      ).rejects.toThrow("Stok Sage tidak cukup (stok sekarang 2.00 yard).");
      await expect(
        reclassifyFabricStock({ fabricId: fabric.id, fromColorId: null, toColorId: mocca.id, qty: 1, note: "x" }, null, tx),
      ).rejects.toThrow("Stok Tanpa warna tidak cukup (stok sekarang 0.00 yard).");
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 2, valueAmount: 40_000 });
    });
  });

  test("refuses the same colour, a colour of another fabric, an inactive target, an empty reason and a bad quantity", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const other = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca", isActive: false });
      const foreign = await insertFabricColor(tx, other.id, { name: "Asing" });
      await stockIn(tx, fabric.id, sage.id, 10, 100_000);
      const move = (input: Partial<Parameters<typeof reclassifyFabricStock>[0]>) =>
        reclassifyFabricStock({ fabricId: fabric.id, fromColorId: sage.id, toColorId: sage.id, qty: 1, note: "alasan", ...input }, null, tx);

      await expect(move({})).rejects.toThrow("Pilih warna tujuan yang berbeda dari warna asal.");
      await expect(move({ toColorId: foreign.id })).rejects.toThrow("Warna tujuan tidak ditemukan untuk bahan ini.");
      await expect(move({ fromColorId: foreign.id, toColorId: sage.id })).rejects.toThrow("Warna asal tidak ditemukan untuk bahan ini.");
      await expect(move({ toColorId: mocca.id })).rejects.toThrow("Warna Mocca sudah nonaktif.");
      await expect(move({ toColorId: null as unknown as string })).rejects.toThrow(FieldError);
      await expect(move({ note: "   " })).rejects.toThrow("Alasan wajib diisi.");
      await expect(move({ qty: 0 })).rejects.toThrow("Jumlah harus lebih dari 0.");
      await expect(move({ qty: -1 })).rejects.toThrow("Jumlah harus lebih dari 0.");
      await expect(move({ qty: 1.005 })).rejects.toThrow("Maksimal 2 desimal.");
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 10, valueAmount: 100_000 });
    });
  });

  test("an inactive colour can still be a SOURCE (moving its leftover stock out)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      await stockIn(tx, fabric.id, mocca.id, 4, 80_000);
      await tx.update(fabricColors).set({ isActive: false }).where(eq(fabricColors.id, mocca.id));
      await reclassifyFabricStock({ fabricId: fabric.id, fromColorId: mocca.id, toColorId: sage.id, qty: 4, note: "Warna dihentikan" }, null, tx);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 4, valueAmount: 80_000 });
    });
  });
});

describe("voidFabricPurchase checks the bucket it subtracts from (S3 gap)", () => {
  test("refused when it would take Tanpa warna below zero, even though the fabric total stays positive", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const staff = await insertStaffUser(tx);
      // A Tanpa warna bucket already at -2 (as a rollback to a pre-S5 release could leave it),
      // written BEFORE the legacy purchase so the later-movement rule does not fire first.
      const earlier = new Date("2026-10-01T00:00:00Z");
      await tx.insert(fabricStockMovements).values([
        { fabricId: fabric.id, fabricColorId: sage.id, qty: 20, valueAmount: 200_000, type: "purchase", refType: "manual", purchasedAt: "2026-10-01", createdAt: earlier },
        { fabricId: fabric.id, qty: -2, valueAmount: 0, type: "production", refType: "manual", createdAt: earlier },
      ]);
      const purchase = await recordFabricPurchase({ fabricId: fabric.id, qty: 3, totalAmountPaid: 30_000, purchasedAt: "2026-11-01" }, null, tx);

      await expect(voidFabricPurchase(purchase.id, staff.id, tx)).rejects.toThrow("Pembatalan ini akan membuat stok menjadi negatif.");
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 1, valueAmount: 30_000 });
    });
  });
});

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertAccessory, insertFabricColor, insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, fabricColors, fabrics, purchaseItems, suppliers } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { recordPurchasePayment } from "@/lib/supplier-payments/purchase-payments";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import { createPurchase, getPurchaseDocument, listPurchaseFabricOptions, updatePurchase, type PurchaseLineInput } from "./queries";

// docs/plans/fabric-colour-stock.md session S2: purchase lines per colour (D4, decision A2).

async function insertSupplier(tx: TestDatabase) {
  const [supplier] = await tx.insert(suppliers).values({ name: `Supplier Warna ${randomUUID().slice(0, 8)}` }).returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

async function insertFabric(tx: TestDatabase, name = `Marbella ${randomUUID().slice(0, 8)}`) {
  const [fabric] = await tx.insert(fabrics).values({ name }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

function fabricLine(fabricId: string, fabricColorId: string | null, qtyOrdered = 10, totalAmount = 195_000): PurchaseLineInput {
  return { itemType: "fabric", itemId: fabricId, fabricColorId, qtyOrdered, totalAmount };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

async function expectFieldError(promise: Promise<unknown>, message: string | RegExp): Promise<void> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(FieldError);
  expect(error.message).toMatch(message);
}

async function fixture(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const supplier = await insertSupplier(tx);
  const fabric = await insertFabric(tx);
  const sage = await insertFabricColor(tx, fabric.id, { name: "Sage", hex: "#9CAF88" });
  const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
  const base = { supplierId: supplier.id, orderedAt: "2026-11-01" };
  return { staff, supplier, fabric, sage, mocca, base };
}

function storedFile(): StoredPrivateFile {
  const id = randomUUID();
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    id,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2026/11/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1234,
      sha256: sha(id),
      originalFilename: "bukti.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256: sha(randomUUID()),
      jpegQuality: 82,
    },
  };
}

describe("createPurchase: fabric colours", () => {
  test("one line per colour of one fabric; the colour is stored and shown on the document", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, sage, mocca, base } = await fixture(tx);
      const purchase = await createPurchase({ ...base, lines: [fabricLine(fabric.id, sage.id, 10), fabricLine(fabric.id, mocca.id, 8, 156_000)] }, staff.id, tx);
      const rows = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
      expect(rows.map((row) => row.fabricColorId).sort()).toEqual([sage.id, mocca.id].sort());

      const document = await getPurchaseDocument(purchase.id, tx);
      // Colours of one fabric sit together, ordered by name.
      expect(document!.lines.map((line) => [line.colorName, line.colorHex, line.colorIsActive])).toEqual([
        ["Mocca", null, true],
        ["Sage", "#9CAF88", true],
      ]);
    });
  });

  test("a fabric with active colours needs a colour on every line", async () => {
    await withRollback(async (tx) => {
      const { fabric, base } = await fixture(tx);
      await expectFieldError(createPurchase({ ...base, lines: [fabricLine(fabric.id, null)] }, null, tx), `Pilih warna untuk ${fabric.name}.`);
    });
  });

  test("Tanpa warna is allowed for a fabric without active colours (none, or only inactive ones)", async () => {
    await withRollback(async (tx) => {
      const { base } = await fixture(tx);
      const plain = await insertFabric(tx);
      const onlyInactive = await insertFabric(tx);
      await insertFabricColor(tx, onlyInactive.id, { name: "Lama", isActive: false });
      const purchase = await createPurchase({ ...base, lines: [fabricLine(plain.id, null), fabricLine(onlyInactive.id, null)] }, null, tx);
      const document = await getPurchaseDocument(purchase.id, tx);
      expect(document!.lines.every((line) => line.fabricColorId === null && line.colorName === null)).toBe(true);
    });
  });

  test("refuses an inactive colour, a colour of another fabric, a duplicate colour and a colour on an accessory", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, base } = await fixture(tx);
      const inactive = await insertFabricColor(tx, fabric.id, { name: "Lilac", isActive: false });
      const other = await insertFabric(tx);
      const foreign = await insertFabricColor(tx, other.id, { name: "Navy" });
      const accessory = await insertAccessory(tx);

      await expectFieldError(createPurchase({ ...base, lines: [fabricLine(fabric.id, inactive.id)] }, null, tx), "Warna Lilac sudah nonaktif");
      await expectFieldError(createPurchase({ ...base, lines: [fabricLine(fabric.id, foreign.id)] }, null, tx), `Warna tidak ditemukan untuk ${fabric.name}.`);
      await expectFieldError(createPurchase({ ...base, lines: [fabricLine(fabric.id, randomUUID())] }, null, tx), "Warna tidak ditemukan");
      await expectFieldError(createPurchase({ ...base, lines: [fabricLine(fabric.id, sage.id), fabricLine(fabric.id, sage.id, 2)] }, null, tx), "dua kali");
      await expectFieldError(
        createPurchase({ ...base, lines: [{ itemType: "accessory", itemId: accessory.id, fabricColorId: sage.id, qtyOrdered: 1, totalAmount: 1 }] }, null, tx),
        "Warna hanya untuk barang jenis kain.",
      );
    });
  });

  test("the audit entry's lines carry the colour id and name", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, sage, base } = await fixture(tx);
      const purchase = await createPurchase({ ...base, lines: [fabricLine(fabric.id, sage.id)] }, staff.id, tx);
      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "purchase"), eq(auditLog.entityId, purchase.id)));
      const after = entry!.after as { lines: { fabricColorId: string | null; fabricColorName: string | null }[] };
      expect(after.lines).toEqual([expect.objectContaining({ fabricColorId: sage.id, fabricColorName: "Sage" })]);
    });
  });
});

describe("updatePurchase: fabric colours", () => {
  test("a colour deactivated since the order was placed may stay, but not be newly chosen", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, sage, mocca, base } = await fixture(tx);
      const purchase = await createPurchase({ ...base, lines: [fabricLine(fabric.id, sage.id)] }, staff.id, tx);
      const lilac = await insertFabricColor(tx, fabric.id, { name: "Lilac", isActive: false });
      await expectFieldError(updatePurchase(purchase.id, { ...base, lines: [fabricLine(fabric.id, lilac.id)] }, staff.id, tx), "Warna Lilac sudah nonaktif");
      await tx.update(fabricColors).set({ isActive: false }).where(eq(fabricColors.id, sage.id));
      await updatePurchase(purchase.id, { ...base, lines: [fabricLine(fabric.id, sage.id, 12), fabricLine(fabric.id, mocca.id)] }, staff.id, tx);
      const document = await getPurchaseDocument(purchase.id, tx);
      expect(document!.lines.find((line) => line.fabricColorId === sage.id)).toMatchObject({ qtyOrdered: 12, colorIsActive: false });
    });
  });

  test("legacy colourless line (PO-202611-001 case): may be kept, or replaced by per-colour lines whose total still covers what was paid", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplier = await insertSupplier(tx);
      const fabric = await insertFabric(tx, `Marbella Anti UV ${randomUUID().slice(0, 8)}`);
      const base = { supplierId: supplier.id, orderedAt: "2026-11-01" };
      // Ordered while the fabric had no colours: 838 yard × Rp 19.500 = Rp 16.341.000, half paid.
      const purchase = await createPurchase({ ...base, lines: [fabricLine(fabric.id, null, 838, 16_341_000)] }, staff.id, tx);
      await recordPurchasePayment({ purchaseId: purchase.id, paidAt: "2026-11-02", amount: 8_000_000, method: "transfer" }, storedFile(), staff.id, tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });

      // Keeping the legacy line as it is (e.g. only the notes change) is still allowed.
      await updatePurchase(purchase.id, { ...base, notes: "cek warna", lines: [fabricLine(fabric.id, null, 838, 16_341_000)] }, staff.id, tx);

      // Below what was paid: refused (existing rule).
      await expectFieldError(
        updatePurchase(purchase.id, { ...base, lines: [fabricLine(fabric.id, sage.id, 200, 3_900_000), fabricLine(fabric.id, mocca.id, 100, 1_950_000)] }, staff.id, tx),
        "tidak boleh lebih kecil dari yang sudah dibayar",
      );

      // Replaced by per-colour lines (838 yard in total, same price): saved.
      await updatePurchase(
        purchase.id,
        { ...base, lines: [fabricLine(fabric.id, sage.id, 500, 9_750_000), fabricLine(fabric.id, mocca.id, 338, 6_591_000)] },
        staff.id,
        tx,
      );
      const document = await getPurchaseDocument(purchase.id, tx);
      expect(document!.lines.map((line) => [line.colorName, line.qtyOrdered, line.totalAmountPaid])).toEqual([
        ["Mocca", 338, 6_591_000],
        ["Sage", 500, 9_750_000],
      ]);

      // Once gone, a colourless line for this fabric cannot come back (decision A2).
      await expectFieldError(
        updatePurchase(purchase.id, { ...base, lines: [fabricLine(fabric.id, null, 838, 16_341_000)] }, staff.id, tx),
        `Pilih warna untuk ${fabric.name}.`,
      );

      const updates = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "purchase"), eq(auditLog.entityId, purchase.id), eq(auditLog.action, "update")));
      const last = updates.find((row) => (row.after as { lines: { fabricColorName: string | null }[] }).lines.some((line) => line.fabricColorName === "Sage"));
      expect((last!.before as { lines: { fabricColorId: string | null; fabricColorName: string | null }[] }).lines).toEqual([
        expect.objectContaining({ fabricColorId: null, fabricColorName: null }),
      ]);
    });
  });
});

describe("listPurchaseFabricOptions", () => {
  test("active colours per fabric, plus kept inactive colours only when asked", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage } = await fixture(tx);
      const lilac = await insertFabricColor(tx, fabric.id, { name: "Lilac", isActive: false });
      const plain = await insertFabric(tx);

      const options = await listPurchaseFabricOptions([], tx);
      expect(options.find((option) => option.id === fabric.id)!.colors.map((color) => color.name)).toEqual(["Mocca", "Sage"]);
      expect(options.find((option) => option.id === plain.id)!.colors).toEqual([]);

      const editing = await listPurchaseFabricOptions([lilac.id, sage.id], tx);
      expect(editing.find((option) => option.id === fabric.id)!.colors.map((color) => [color.name, color.isActive])).toEqual([
        ["Lilac", false],
        ["Mocca", true],
        ["Sage", true],
      ]);
    });
  });
});

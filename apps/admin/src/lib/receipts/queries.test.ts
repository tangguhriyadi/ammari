import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertAccessory, insertStaffUser } from "@ammari/db/test-fixtures";
import { accessories, accessoryMovements, auditLog, fabrics, fabricStockMovements, purchaseItems, purchases, suppliers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { getAccessoryBalance, recordAccessoryAdjustment, voidAccessoryPurchase } from "@/lib/inventory/accessories";
import { getFabricBalance, recordFabricPurchase, voidFabricPurchase } from "@/lib/inventory/fabric-stock";
import { getPurchaseById, listPurchases } from "@/lib/inventory/purchases";
import { closePurchase, createPurchase, getPurchaseDocument, listPurchaseDocuments, updatePurchase } from "@/lib/purchases/queries";
import { findPurchaseIdForReceiptMovement, listReceiptsForPurchase, postGoodsReceiptForPurchase, reverseGoodsReceipt } from "./queries";

// docs/plans/suppliers-goods-receipt.md session S3: purchase documents and purchase receipts
// (accepted quantities only).

async function insertSupplier(tx: TestDatabase, overrides: Partial<typeof suppliers.$inferInsert> = {}) {
  const [supplier] = await tx
    .insert(suppliers)
    .values({ name: `Supplier Test ${randomUUID().slice(0, 8)}`, ...overrides })
    .returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx
    .insert(fabrics)
    .values({ name: `Katun Test ${randomUUID().slice(0, 8)}` })
    .returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

/** Two-line purchase: 10 yards of fabric for Rp 1.000.000 and 3 pcs of an accessory for Rp 100. */
async function twoLinePurchase(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const supplier = await insertSupplier(tx);
  const fabric = await insertFabric(tx);
  const accessory = await insertAccessory(tx);
  const purchase = await createPurchase(
    {
      supplierId: supplier.id,
      orderedAt: "2026-10-01",
      lines: [
        { itemType: "fabric", itemId: fabric.id, qtyOrdered: 10, totalAmount: 1_000_000 },
        { itemType: "accessory", itemId: accessory.id, qtyOrdered: 3, totalAmount: 100 },
      ],
    },
    staff.id,
    tx,
  );
  const lines = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
  const fabricLine = lines.find((line) => line.fabricId === fabric.id)!;
  const accessoryLine = lines.find((line) => line.accessoryId === accessory.id)!;
  return { staff, supplier, fabric, accessory, purchase, fabricLine, accessoryLine };
}

function receive(tx: TestDatabase, purchaseId: string, actorId: string, lines: { purchaseItemId: string; qtyAccepted: number }[]) {
  return postGoodsReceiptForPurchase({ purchaseId, receivedAt: "2026-10-05", lines }, actorId, tx);
}

async function statusOf(tx: TestDatabase, purchaseId: string) {
  const [row] = await tx.select({ status: purchases.status }).from(purchases).where(eq(purchases.id, purchaseId));
  return row?.status;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

/** drizzle wraps the driver error; a trigger's own RAISE text is on `.cause`. */
async function causeMessageOf(promise: Promise<unknown>): Promise<string> {
  const error = await rejection(promise);
  return String(error.cause instanceof Error ? error.cause : error);
}

describe("createPurchase", () => {
  test("records a document with a PO number and lines, and moves NO stock", async () => {
    await withRollback(async (tx) => {
      const { purchase, fabric, accessory } = await twoLinePurchase(tx);
      expect(purchase.purchaseNo).toMatch(/^PO-\d{6}-\d{3}$/);
      expect(purchase.status).toBe("ordered");
      expect((await getFabricBalance(fabric.id, tx)).qty).toBe(0);
      expect((await getAccessoryBalance(accessory.id, tx)).qty).toBe(0);
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "purchase"), eq(auditLog.entityId, purchase.id)));
      expect(audits.map((row) => row.action)).toEqual(["create"]);
    });
  });

  test("requires an active supplier", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx, { isActive: false });
      const fabric = await insertFabric(tx);
      const error = await rejection(
        createPurchase(
          { supplierId: supplier.id, orderedAt: "2026-10-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 1, totalAmount: 1 }] },
          null,
          tx,
        ),
      );
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe("supplierId");
    });
  });

  test("refuses no lines, duplicate items and fractional accessory quantities", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const fabric = await insertFabric(tx);
      const accessory = await insertAccessory(tx);
      const base = { supplierId: supplier.id, orderedAt: "2026-10-01" };
      await expect(createPurchase({ ...base, lines: [] }, null, tx)).rejects.toThrow("minimal satu");
      await expect(
        createPurchase(
          {
            ...base,
            lines: [
              { itemType: "fabric", itemId: fabric.id, qtyOrdered: 1, totalAmount: 1 },
              { itemType: "fabric", itemId: fabric.id, qtyOrdered: 2, totalAmount: 1 },
            ],
          },
          null,
          tx,
        ),
      ).rejects.toThrow("dua kali");
      await expect(
        createPurchase({ ...base, lines: [{ itemType: "accessory", itemId: accessory.id, qtyOrdered: 1.5, totalAmount: 1 }] }, null, tx),
      ).rejects.toThrow("bilangan bulat");
    });
  });
});

describe("postGoodsReceiptForPurchase", () => {
  test("partial receipt: stock rises by exactly the accepted quantity, valued as a slice; status partially_received", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine, supplier } = await twoLinePurchase(tx);
      const { receipt, status } = await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 4 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 1 },
      ]);
      expect(receipt.receiptNo).toMatch(/^GR-\d{6}-\d{3}$/);
      expect(status).toBe("partially_received");
      expect(await statusOf(tx, purchase.id)).toBe("partially_received");

      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 4, valueAmount: 400_000 });
      expect(await getAccessoryBalance(accessory.id, tx)).toEqual({ qty: 1, valueAmount: 33 });

      const [movement] = await tx.select().from(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabric.id));
      expect(movement).toMatchObject({ type: "purchase", refType: "goods_receipt", purchasedAt: "2026-10-05", supplierId: supplier.id, supplier: supplier.name });

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "goods_receipt"), eq(auditLog.entityId, receipt.id)));
      expect(audits.map((row) => row.action)).toEqual(["receive"]);
    });
  });

  test("a second receipt completes the document: received, and the slices sum to exactly what was paid", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine } = await twoLinePurchase(tx);
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 3.33 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 1 },
      ]);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 1 }]);
      const { status } = await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 6.67 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 1 },
      ]);
      expect(status).toBe("received");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 10, valueAmount: 1_000_000 });
      expect(await getAccessoryBalance(accessory.id, tx)).toEqual({ qty: 3, valueAmount: 100 });
    });
  });

  test("over-receipt is refused with an Indonesian message naming the line and what is left, and nothing moves", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await twoLinePurchase(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8 }]);
      const error = await rejection(receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2.5 }]));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toContain(fabric.name);
      expect(error.message).toContain("melebihi sisa pesanan");
      expect(error.message).toContain("2.00 yard");
      expect((await getFabricBalance(fabric.id, tx)).qty).toBe(8);
    });
  });

  test("an all-zero receipt is refused", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await twoLinePurchase(tx);
      await expect(receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 0 }])).rejects.toThrow("minimal");
    });
  });

  test("a fractional accessory quantity and a future date are refused", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, accessoryLine } = await twoLinePurchase(tx);
      await expect(receive(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 1.5 }])).rejects.toThrow("bilangan bulat");
      await expect(
        postGoodsReceiptForPurchase(
          { purchaseId: purchase.id, receivedAt: "2999-01-01", lines: [{ purchaseItemId: accessoryLine.id, qtyAccepted: 1 }] },
          staff.id,
          tx,
        ),
      ).rejects.toThrow("masa depan");
    });
  });

  test("a line from another purchase is refused", async () => {
    await withRollback(async (tx) => {
      const first = await twoLinePurchase(tx);
      const second = await twoLinePurchase(tx);
      await expect(receive(tx, first.purchase.id, first.staff.id, [{ purchaseItemId: second.fabricLine.id, qtyAccepted: 1 }])).rejects.toThrow(
        "bukan bagian",
      );
    });
  });

  test("receipts against a closed, a cancelled or a fully received document are refused", async () => {
    await withRollback(async (tx) => {
      const closed = await twoLinePurchase(tx);
      await receive(tx, closed.purchase.id, closed.staff.id, [{ purchaseItemId: closed.fabricLine.id, qtyAccepted: 1 }]);
      await closePurchase(closed.purchase.id, "Sisanya tidak dikirim", closed.staff.id, tx);
      await expect(receive(tx, closed.purchase.id, closed.staff.id, [{ purchaseItemId: closed.fabricLine.id, qtyAccepted: 1 }])).rejects.toThrow(
        "sudah ditutup",
      );

      const received = await twoLinePurchase(tx);
      await receive(tx, received.purchase.id, received.staff.id, [
        { purchaseItemId: received.fabricLine.id, qtyAccepted: 10 },
        { purchaseItemId: received.accessoryLine.id, qtyAccepted: 3 },
      ]);
      await expect(
        receive(tx, received.purchase.id, received.staff.id, [{ purchaseItemId: received.fabricLine.id, qtyAccepted: 1 }]),
      ).rejects.toThrow("sudah diterima");
    });
  });
});

describe("closePurchase (D19)", () => {
  test("nothing arrived: cancelled, with the reason and closer stamped and an audit entry", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await twoLinePurchase(tx);
      const closed = await closePurchase(purchase.id, "  Supplier batal kirim  ", staff.id, tx);
      expect(closed.status).toBe("cancelled");
      expect(closed.closeReason).toBe("Supplier batal kirim");
      expect(closed.closedByStaffUserId).toBe(staff.id);
      expect(closed.closedAt).not.toBeNull();
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "purchase"), eq(auditLog.action, "close"), eq(auditLog.entityId, purchase.id)));
      expect(audits).toHaveLength(1);
    });
  });

  test("something arrived: closed, and stock is untouched", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await twoLinePurchase(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 4 }]);
      const closed = await closePurchase(purchase.id, "Sisa tidak tersedia", staff.id, tx);
      expect(closed.status).toBe("closed");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 4, valueAmount: 400_000 });
    });
  });

  test("a reason is required, and a closed or received document can't be closed again", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await twoLinePurchase(tx);
      await expect(closePurchase(purchase.id, "   ", staff.id, tx)).rejects.toThrow("Alasan wajib diisi");
      await closePurchase(purchase.id, "Batal", staff.id, tx);
      await expect(closePurchase(purchase.id, "Lagi", staff.id, tx)).rejects.toBeInstanceOf(ActionError);
    });
  });
});

describe("reverseGoodsReceipt", () => {
  test("reverses exactly: stock and value back, status recomputed, reversal receipt recorded, audit entry", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine } = await twoLinePurchase(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 3 }]);
      const { receipt } = await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 7 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 3 },
      ]);
      expect(await statusOf(tx, purchase.id)).toBe("received");

      const { reversal, status } = await reverseGoodsReceipt(receipt.id, staff.id, tx);
      expect(status).toBe("partially_received");
      expect(reversal.kind).toBe("reversal");
      expect(reversal.reversesReceiptId).toBe(receipt.id);
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 3, valueAmount: 300_000 });
      expect(await getAccessoryBalance(accessory.id, tx)).toEqual({ qty: 0, valueAmount: 0 });

      const voids = await tx.select().from(accessoryMovements).where(and(eq(accessoryMovements.accessoryId, accessory.id), eq(accessoryMovements.type, "purchase_void")));
      expect(voids).toHaveLength(1);
      expect(voids[0]?.refType).toBe("goods_receipt");

      const receipts = await listReceiptsForPurchase(purchase.id, tx);
      expect(receipts.find((row) => row.id === receipt.id)?.reversedAt).not.toBeNull();
      expect(receipts.find((row) => row.id === reversal.id)?.reversesReceiptNo).toBe(receipt.receiptNo);

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "goods_receipt"), eq(auditLog.action, "reverse")));
      expect(audits.some((row) => row.entityId === receipt.id)).toBe(true);

      // Re-receiving after the reversal completes the line at exactly the amount paid.
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 7 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 3 },
      ]);
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 10, valueAmount: 1_000_000 });
      expect(await getAccessoryBalance(accessory.id, tx)).toEqual({ qty: 3, valueAmount: 100 });
      expect(await statusOf(tx, purchase.id)).toBe("received");
    });
  });

  test("reversing an EARLIER receipt out of order still lets the line complete at exactly the total", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, accessory, accessoryLine } = await twoLinePurchase(tx);
      const { receipt: first } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 1 }]);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 1 }]);
      await reverseGoodsReceipt(first.id, staff.id, tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 2 }]);
      expect(await getAccessoryBalance(accessory.id, tx)).toEqual({ qty: 3, valueAmount: 100 });
    });
  });

  test("reversing the only receipt returns the document to ordered", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await twoLinePurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2 }]);
      expect((await reverseGoodsReceipt(receipt.id, staff.id, tx)).status).toBe("ordered");
    });
  });

  test("reversing a closed document's only receipt keeps it terminal, as cancelled (D19 on net quantities)", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await twoLinePurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2 }]);
      await closePurchase(purchase.id, "Sisa batal", staff.id, tx);
      expect((await reverseGoodsReceipt(receipt.id, staff.id, tx)).status).toBe("cancelled");
    });
  });

  test("a double reversal, and reversing a reversal, are refused", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await twoLinePurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2 }]);
      const { reversal } = await reverseGoodsReceipt(receipt.id, staff.id, tx);
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("sudah dibatalkan");
      await expect(reverseGoodsReceipt(reversal.id, staff.id, tx)).rejects.toBeInstanceOf(ActionError);
    });
  });

  test("refused once the material has been consumed or adjusted after the receipt", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, accessory, accessoryLine } = await twoLinePurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 3 }]);
      await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -1, reason: "damaged" }, staff.id, tx);
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("Sesuaikan stok");
      expect((await getAccessoryBalance(accessory.id, tx)).qty).toBe(2);
    });
  });
});

describe("line freeze (D7)", () => {
  test("the trigger refuses changing or deleting a line that has a receipt, and frees it once every receipt is reversed", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await twoLinePurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2 }]);

      // Each attempt in its own savepoint, so one rejected statement doesn't abort the test's
      // outer transaction.
      const attempt = (fn: (sp: TestDatabase) => Promise<unknown>) => causeMessageOf(tx.transaction(async (sp) => fn(sp)));
      expect(await attempt((sp) => sp.update(purchaseItems).set({ qtyOrdered: 20 }).where(eq(purchaseItems.id, fabricLine.id)))).toContain(
        "already has a receipt",
      );
      expect(await attempt((sp) => sp.update(purchaseItems).set({ totalAmount: 1 }).where(eq(purchaseItems.id, fabricLine.id)))).toContain(
        "already has a receipt",
      );
      expect(await attempt((sp) => sp.delete(purchaseItems).where(eq(purchaseItems.id, fabricLine.id)))).toContain("already has a receipt");

      await reverseGoodsReceipt(receipt.id, staff.id, tx);
      await tx.update(purchaseItems).set({ qtyOrdered: 20 }).where(eq(purchaseItems.id, fabricLine.id));
    });
  });

  test("updatePurchase edits header and lines while nothing was received, and is refused once any receipt exists", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, supplier, fabric, fabricLine } = await twoLinePurchase(tx);
      const edited = await updatePurchase(
        purchase.id,
        { supplierId: supplier.id, orderedAt: "2026-10-02", notes: "Ganti jumlah", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 12, totalAmount: 1_200_000 }] },
        staff.id,
        tx,
      );
      expect(edited.orderedAt).toBe("2026-10-02");
      const document = await getPurchaseDocument(purchase.id, tx);
      expect(document?.lines.map((line) => [line.qtyOrdered, line.totalAmountPaid])).toEqual([[12, 1_200_000]]);

      const [newLine] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: newLine!.id, qtyAccepted: 1 }]);
      await expect(
        updatePurchase(
          purchase.id,
          { supplierId: supplier.id, orderedAt: "2026-10-02", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 20, totalAmount: 1 }] },
          staff.id,
          tx,
        ),
      ).rejects.toThrow("tidak bisa diubah");
      expect(fabricLine.id).not.toBe(newLine!.id);
    });
  });
});

describe("legacy single-row purchases (D11): still listed, displayed and counted exactly once", () => {
  test("a legacy purchase and a document receipt on the same fabric each count once", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await twoLinePurchase(tx);
      const legacy = await recordFabricPurchase({ fabricId: fabric.id, qty: 5, totalAmountPaid: 250_000, purchasedAt: "2026-09-01" }, staff.id, tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 4 }]);

      // Stock: legacy 5 + received 4, never 4 twice and never the ordered 10.
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 9, valueAmount: 650_000 });

      // The legacy list shows the legacy row only; the receipt row belongs to the document.
      const { rows } = await listPurchases({ type: "fabric", q: fabric.name }, undefined, undefined, tx);
      expect(rows.map((row) => row.id)).toEqual([legacy.id]);
      const all = await listPurchases({ q: fabric.name }, undefined, undefined, tx);
      expect(all.rows.map((row) => row.id)).toEqual([legacy.id]);
      expect(await getPurchaseById(legacy.id, tx)).not.toBeNull();

      const [receiptRow] = await tx
        .select()
        .from(fabricStockMovements)
        .where(and(eq(fabricStockMovements.fabricId, fabric.id), eq(fabricStockMovements.refType, "goods_receipt")));
      expect(await getPurchaseById(receiptRow!.id, tx)).toBeNull();
      expect(await findPurchaseIdForReceiptMovement(receiptRow!.id, tx)).toBe(purchase.id);
      expect(await findPurchaseIdForReceiptMovement(legacy.id, tx)).toBeNull();

      // And the document list shows the document, not the legacy row.
      const documents = await listPurchaseDocuments({ q: purchase.purchaseNo }, undefined, undefined, tx);
      expect(documents.rows.map((row) => row.id)).toEqual([purchase.id]);
      expect(documents.rows[0]).toMatchObject({ itemCount: 2, totalAmountPaid: 1_000_100, status: "partially_received" });
    });
  });

  test("editing keeps an accessory line whose accessory was deactivated since, but refuses adding a NEW inactive one", async () => {
    await withRollback(async (tx) => {
      const { staff, supplier, purchase, fabric, accessory } = await twoLinePurchase(tx);
      await tx.update(accessories).set({ isActive: false }).where(eq(accessories.id, accessory.id));
      const lines = (accessoryQty: number) => [
        { itemType: "fabric" as const, itemId: fabric.id, qtyOrdered: 12, totalAmount: 1_200_000 },
        { itemType: "accessory" as const, itemId: accessory.id, qtyOrdered: accessoryQty, totalAmount: 100 },
      ];
      await updatePurchase(purchase.id, { supplierId: supplier.id, orderedAt: "2026-10-02", lines: lines(3) }, staff.id, tx);

      const other = await insertAccessory(tx);
      await tx.update(accessories).set({ isActive: false }).where(eq(accessories.id, other.id));
      await expect(
        updatePurchase(
          purchase.id,
          { supplierId: supplier.id, orderedAt: "2026-10-02", lines: [...lines(3), { itemType: "accessory", itemId: other.id, qtyOrdered: 1, totalAmount: 10 }] },
          staff.id,
          tx,
        ),
      ).rejects.toThrow("sudah nonaktif");
    });
  });

  test("a receipt reversal's purchase_void rows resolve to the same purchase document (S7 ledger link)", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine } = await twoLinePurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 1 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 1 },
      ]);
      await reverseGoodsReceipt(receipt.id, staff.id, tx);
      const [fabricVoid] = await tx
        .select()
        .from(fabricStockMovements)
        .where(and(eq(fabricStockMovements.fabricId, fabric.id), eq(fabricStockMovements.type, "purchase_void")));
      const [accessoryVoid] = await tx
        .select()
        .from(accessoryMovements)
        .where(and(eq(accessoryMovements.accessoryId, accessory.id), eq(accessoryMovements.type, "purchase_void")));
      expect(fabricVoid?.refType).toBe("goods_receipt");
      expect(await findPurchaseIdForReceiptMovement(fabricVoid!.id, tx)).toBe(purchase.id);
      expect(await findPurchaseIdForReceiptMovement(accessoryVoid!.id, tx)).toBe(purchase.id);
    });
  });

  test("the legacy void path still voids a legacy purchase but refuses a receipt-backed row", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine } = await twoLinePurchase(tx);
      const legacy = await recordFabricPurchase({ fabricId: fabric.id, qty: 5, totalAmountPaid: 250_000, purchasedAt: "2026-09-01" }, staff.id, tx);
      await voidFabricPurchase(legacy.id, staff.id, tx);

      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 1 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 1 },
      ]);
      const [fabricRow] = await tx.select().from(fabricStockMovements).where(and(eq(fabricStockMovements.fabricId, fabric.id), eq(fabricStockMovements.refType, "goods_receipt")));
      const [accessoryRow] = await tx.select().from(accessoryMovements).where(eq(accessoryMovements.accessoryId, accessory.id));
      await expect(voidFabricPurchase(fabricRow!.id, staff.id, tx)).rejects.toThrow("Batalkan penerimaan");
      await expect(voidAccessoryPurchase(accessoryRow!.id, staff.id, tx)).rejects.toThrow("Batalkan penerimaan");
    });
  });
});

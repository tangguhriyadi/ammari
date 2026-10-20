"use server";

import { z } from "zod";
import { PURCHASE_ITEM_TYPES } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { moneyString } from "@/lib/products/money-schema";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
import { runAction, type ActionResult } from "@/lib/action-result";
import { voidFabricPurchase } from "@/lib/inventory/fabric-stock";
import { voidAccessoryPurchase } from "@/lib/inventory/accessories";
import { MAX_LINES, MAX_QTY, closePurchase, createPurchase, updatePurchase, type PurchaseInput } from "@/lib/purchases/queries";
import { postGoodsReceiptForPurchase, reverseGoodsReceipt } from "@/lib/receipts/queries";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { revalidateStorefrontForSkus, skusForReceipt } from "@/lib/storefront-stock";

// A posted or reversed receipt moves stock: it shows on receipts, every stock view, and the
// fabric/accessory detail ledgers, not only on the purchase itself.
const RECEIPT_SECTIONS = ["/purchases", "/receipts", "/stock", "/fabrics", "/accessories"] as const;

// Purchase documents and their goods receipts (docs/plans/suppliers-goods-receipt.md S3).
// Permissions (D10): inventory.manage creates/edits/closes documents and reverses receipts;
// inventory.receive posts a receipt. Every action re-checks on the server.

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Input tidak valid.";
}

const purchaseLineSchema = z.object({
  itemType: z.enum(PURCHASE_ITEM_TYPES),
  itemId: z.string().uuid("Pilih barang terlebih dahulu."),
  qtyOrdered: z.string().transform((value, ctx) => {
    const parsed = parseDecimalQuantity(value);
    if (parsed === null || parsed > MAX_QTY) {
      ctx.addIssue({ code: "custom", message: "Jumlah dipesan tidak valid." });
      return z.NEVER;
    }
    return parsed;
  }),
  totalAmount: moneyString,
});

const purchaseSchema = z.object({
  supplierId: z.string().uuid("Pilih supplier terlebih dahulu."),
  orderedAt: z.string().date("Tanggal tidak valid."),
  notes: z.string().trim().max(1000, "Catatan terlalu panjang.").optional(),
  lines: z.array(purchaseLineSchema).min(1, "Tambahkan minimal satu barang.").max(MAX_LINES, `Maksimal ${MAX_LINES} barang dalam satu pesanan.`),
});

function toPurchaseInput(parsed: z.infer<typeof purchaseSchema>): PurchaseInput {
  return { supplierId: parsed.supplierId, orderedAt: parsed.orderedAt, notes: parsed.notes || null, lines: parsed.lines };
}

export async function createPurchaseAction(input: z.input<typeof purchaseSchema>): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = purchaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    const purchase = await createPurchase(toPurchaseInput(parsed.data), session.staffUser.id);
    revalidateAdmin("/purchases");
    return { id: purchase.id };
  });
}

/** Also needs finance.view_profit: the edit form shows and re-saves every line's total, so a
 * session that cannot see cost figures must not be able to overwrite them blind (the edit page
 * applies the same rule; this is the server-side enforcement). */
export async function updatePurchaseAction(id: string, input: z.input<typeof purchaseSchema>): Promise<ActionResult<{ id: string }>> {
  const session = await requireAllPermissions(["inventory.manage", "finance.view_profit"]);
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Pesanan pembelian tidak ditemukan." };
  const parsed = purchaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    const purchase = await updatePurchase(parsedId.data, toPurchaseInput(parsed.data), session.staffUser.id);
    revalidateAdmin("/purchases");
    return { id: purchase.id };
  });
}

/** An empty or "0" quantity means "nothing of this line arrived in this delivery" and is dropped;
 * anything else must be a valid positive quantity with at most two decimals. */
function receiptQuantity(message: string) {
  return z.string().transform((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed === "" || /^0+(\.0+)?$/.test(trimmed)) return 0;
    const parsed = parseDecimalQuantity(trimmed);
    if (parsed === null || parsed > MAX_QTY) {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return parsed;
  });
}

const receiptQtySchema = receiptQuantity("Jumlah diterima tidak valid.");
/** "Ditolak (cacat)" (S5): units that arrived defective go to defect stock, never to sellable
 * stock. Optional so an older client that never sends it still reads as "nothing rejected". */
const rejectedQtySchema = receiptQuantity("Jumlah ditolak tidak valid.").optional();

const receiveSchema = z.object({
  purchaseId: z.string().uuid(),
  receivedAt: z.string().date("Tanggal tidak valid."),
  receivedByName: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({ purchaseItemId: z.string().uuid(), qtyAccepted: receiptQtySchema, qtyRejected: rejectedQtySchema })).max(MAX_LINES),
});

export async function receivePurchaseAction(input: z.input<typeof receiveSchema>): Promise<ActionResult<{ receiptNo: string }>> {
  const session = await requirePermission("inventory.receive");
  const parsed = receiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    const { receipt } = await postGoodsReceiptForPurchase(
      {
        purchaseId: parsed.data.purchaseId,
        receivedAt: parsed.data.receivedAt,
        receivedByName: parsed.data.receivedByName || null,
        note: parsed.data.note || null,
        lines: parsed.data.lines,
      },
      session.staffUser.id,
    );
    revalidateAdmin(...RECEIPT_SECTIONS);
    return { receiptNo: receipt.receiptNo };
  });
}

const closeSchema = z.object({
  purchaseId: z.string().uuid(),
  reason: z.string().trim().min(1, "Alasan wajib diisi.").max(1000),
});

export async function closePurchaseAction(input: z.input<typeof closeSchema>): Promise<ActionResult<{ status: string }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    const purchase = await closePurchase(parsed.data.purchaseId, parsed.data.reason, session.staffUser.id);
    revalidateAdmin("/purchases", "/receipts");
    return { status: purchase.status };
  });
}

const reverseSchema = z.object({ receiptId: z.string().uuid() });

export async function reverseReceiptAction(input: z.input<typeof reverseSchema>): Promise<ActionResult<{ storefrontOk: boolean }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await reverseGoodsReceipt(parsed.data.receiptId, session.staffUser.id);
    // Production output receipts are reversed through this same action.
    revalidateAdmin(...RECEIPT_SECTIONS, "/production");
    // Only a production receipt has SKUs (a purchase receipt reverses fabric/accessories: none).
    const storefront = await revalidateStorefrontForSkus(() => skusForReceipt(parsed.data.receiptId));
    return { storefrontOk: storefront.ok };
  });
}

const voidPurchaseSchema = z.object({
  type: z.enum(["fabric", "accessory"]),
  movementId: z.string().uuid(),
});

/** LEGACY single-row purchases only (D11) — voided from their own /purchases/[id] detail page.
 * The lib functions refuse a receipt-backed row (that one is reversed through its receipt), and
 * re-check `type = 'purchase'` themselves. */
export async function voidPurchaseAction(input: z.input<typeof voidPurchaseSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = voidPurchaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    if (parsed.data.type === "fabric") {
      await voidFabricPurchase(parsed.data.movementId, session.staffUser.id);
    } else {
      await voidAccessoryPurchase(parsed.data.movementId, session.staffUser.id);
    }
    revalidateAdmin(...RECEIPT_SECTIONS);
    return undefined;
  });
}

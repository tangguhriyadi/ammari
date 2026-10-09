"use server";

import { z } from "zod";
import QRCode from "qrcode";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { ActionError } from "@/lib/errors";
import { defaultDb } from "@/lib/db";
import { transitionOrderStatus } from "@/lib/orders/queries";
import { getCardPrintStatus, getOrderSummaryForCard, mintThankYouCard } from "@/lib/packing/queries";
import { claimUrl, claimUrlHost, formatClaimTokenForDisplay } from "@/lib/packing/token";
import { resolveCardBuyerName } from "@/lib/packing/card-copy";

const orderIdsSchema = z.array(z.string().uuid()).min(1, "Pilih minimal 1 pesanan.");

export async function getCardPrintStatusAction(orderIds: string[]): Promise<ActionResult<Record<string, boolean>>> {
  await requirePermission("packing.print_cards");
  const parsed = orderIdsSchema.safeParse(orderIds);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const status = await getCardPrintStatus(parsed.data);
    return Object.fromEntries(status);
  });
}

export interface PrintableCard {
  orderId: string;
  orderNo: string;
  buyerName: string;
  /** The claim URL's host+path, no token (e.g. "ammari.my.id/claim") — printed on its own line,
   * above `claimTokenDisplay`. */
  claimUrlHost: string;
  /** The grouped, human-typable token (e.g. "XXXX-XXXX-XXXX-XXXX-XXXX-XX") — printed on its own
   * line, below `claimUrlHost`. */
  claimTokenDisplay: string;
  qrSvg: string;
}

export async function printThankYouCardsAction(orderIds: string[]): Promise<ActionResult<PrintableCard[]>> {
  const session = await requirePermission("packing.print_cards");
  const parsed = orderIdsSchema.safeParse(orderIds);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  // Deduped — this is a public server action, not just the (Set-backed, naturally-deduped)
  // client call site: a crafted request repeating the same orderId would otherwise mint it
  // twice in the same batch, with the second mint silently voiding the first's card before the
  // response is ever sent — the client would show a token that's already dead on arrival.
  const dedupedOrderIds = [...new Set(parsed.data)];
  return runAction(async () =>
    // One transaction for the WHOLE batch, not one per order — if any order later in the batch
    // fails (not found, already cancelled/returned), every mint already committed for earlier
    // orders in this same batch would otherwise stay committed while the thrown error discards
    // the in-memory `results` array, leaving those orders with a voided old card, a fresh active
    // one, and no token ever delivered to anyone. Wrapping in one transaction makes the whole
    // batch succeed or fail together.
    defaultDb.transaction(async (tx) => {
      const results: PrintableCard[] = [];
      for (const orderId of dedupedOrderIds) {
        const order = await getOrderSummaryForCard(orderId, tx);
        if (!order) throw new ActionError(`Pesanan ${orderId} tidak ditemukan.`);
        const minted = await mintThankYouCard(orderId, session.staffUser.id, tx);
        const url = claimUrl(minted.token);
        const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "Q", margin: 0 });
        results.push({
          orderId,
          orderNo: order.orderNo,
          buyerName: resolveCardBuyerName(order),
          claimUrlHost: claimUrlHost(),
          claimTokenDisplay: formatClaimTokenForDisplay(minted.token),
          qrSvg,
        });
      }
      return results;
    }),
  );
}

const markShippedSchema = z.object({
  orderId: z.string().uuid(),
  courier: z.string().trim().optional(),
  trackingNumber: z.string().trim().optional(),
  confirmNoCard: z.boolean(),
});

export async function markShippedAction(input: z.input<typeof markShippedSchema>): Promise<ActionResult> {
  const session = await requirePermission("orders.manage");
  const parsed = markShippedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    if (!parsed.data.confirmNoCard) {
      const status = await getCardPrintStatus([parsed.data.orderId]);
      if (status.get(parsed.data.orderId) === false) {
        throw new ActionError("Pesanan ini belum punya kartu terima kasih. Konfirmasi untuk tetap mengirim.");
      }
    }
    await transitionOrderStatus(parsed.data.orderId, "shipped", session.staffUser.id, undefined, {
      courier: parsed.data.courier || null,
      trackingNumber: parsed.data.trackingNumber || null,
    });
    return undefined;
  });
}

const bulkMarkShippedSchema = z.object({
  orderIds: orderIdsSchema,
  confirmNoCard: z.boolean(),
});

export async function bulkMarkShippedAction(input: z.input<typeof bulkMarkShippedSchema>): Promise<ActionResult> {
  const session = await requirePermission("orders.manage");
  const parsed = bulkMarkShippedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    if (!parsed.data.confirmNoCard) {
      const status = await getCardPrintStatus(parsed.data.orderIds);
      const missing = parsed.data.orderIds.filter((id) => status.get(id) === false);
      if (missing.length > 0) {
        throw new ActionError("Sebagian pesanan ini belum punya kartu terima kasih. Konfirmasi untuk tetap mengirim.");
      }
    }
    // Sequential — transitionOrderStatus is its own transaction per order; nothing here needs
    // (or would benefit from) a single cross-order transaction.
    for (const orderId of parsed.data.orderIds) {
      await transitionOrderStatus(orderId, "shipped", session.staffUser.id);
    }
    return undefined;
  });
}

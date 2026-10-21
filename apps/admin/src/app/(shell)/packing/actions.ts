"use server";

import { z } from "zod";
import QRCode from "qrcode";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { ActionError } from "@/lib/errors";
import { defaultDb } from "@/lib/db";
import { transitionOrderStatus } from "@ammari/commerce/orders";
import { getCardPrintStatus, getCheckoutOrderNos, getOrdersMissingCard, mintThankYouCardsForOrders } from "@/lib/packing/queries";
import { claimUrl, claimUrlHost, formatClaimTokenForDisplay } from "@/lib/packing/token";
import { buildStickerSheetPdf, stickerPdfFilename, type StickerPdfCard } from "@/lib/packing/sticker-pdf";
import { revalidateAdmin } from "@/lib/admin-revalidate";

// Upper-bounded, not just non-empty — `printStickerSheetsAction` mints/rotates a card AND builds
// a PDF for every id in one request, inside one DB transaction holding `orders` row locks for
// its whole duration; an unbounded array (the shared server-action body limit is 12MB, sized for
// product-image uploads — next.config.ts — which fits hundreds of thousands of UUIDs) would be a
// real memory/lock-duration DoS from any account holding only `packing.print_cards`. 500 is
// comfortably above any realistic physical sticker/card print batch.
const orderIdsSchema = z.array(z.string().uuid()).min(1, "Pilih minimal 1 pesanan.").max(500, "Maksimal 500 pesanan sekaligus.");

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
  const result = await runAction(async () =>
    // One transaction for the WHOLE batch, not one per order — if any order later in the batch
    // fails (not found, already cancelled/returned), every mint already committed for earlier
    // orders in this same batch would otherwise stay committed while the thrown error discards
    // the in-memory `results` array, leaving those orders with a voided old card, a fresh active
    // one, and no token ever delivered to anyone. Wrapping in one transaction makes the whole
    // batch succeed or fail together.
    defaultDb.transaction(async (tx) => {
      const minted = await mintThankYouCardsForOrders(parsed.data, session.staffUser.id, tx);
      const results: PrintableCard[] = [];
      for (const card of minted) {
        const url = claimUrl(card.token);
        const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "Q", margin: 0 });
        results.push({
          orderId: card.orderId,
          orderNo: card.orderNo,
          buyerName: card.buyerName,
          claimUrlHost: claimUrlHost(),
          claimTokenDisplay: formatClaimTokenForDisplay(card.token),
          qrSvg,
        });
      }
      return results;
    }),
  );
  // After the transaction has committed, not inside it: printing mints (or rotates) each order's
  // card, which the packing queue and order pages show as card status.
  if (result.ok) revalidateAdmin("/packing", "/orders");
  return result;
}

export interface StickerSheetPdfResult {
  filename: string;
  /** Base64-encoded PDF bytes — travels through the existing `ActionResult` envelope like every
   * other action in this codebase, rather than a dedicated Route Handler
   * (docs/plans/thermal-stickers.md). The client decodes it into a `Blob` and triggers a real
   * file download. */
  pdfBase64: string;
}

export async function printStickerSheetsAction(orderIds: string[]): Promise<ActionResult<StickerSheetPdfResult>> {
  const session = await requirePermission("packing.print_cards");
  const parsed = orderIdsSchema.safeParse(orderIds);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const minted = await defaultDb.transaction((tx) => mintThankYouCardsForOrders(parsed.data, session.staffUser.id, tx));
    revalidateAdmin("/packing", "/orders");
    const cards: StickerPdfCard[] = minted.map((card) => ({
      orderId: card.orderId,
      code: card.stickerCode,
      claimUrl: claimUrl(card.token),
    }));
    const pdfBytes = await buildStickerSheetPdf(cards);
    return {
      filename: stickerPdfFilename(new Date()),
      pdfBase64: Buffer.from(pdfBytes).toString("base64"),
    };
  });
}

// Bounded here; the real rules (both required on a web checkout order, the resi's shape) run in
// transitionOrderStatus under the order's row lock (@ammari/commerce/shipment-details).
const markShippedSchema = z.object({
  orderId: z.string().uuid(),
  courier: z.string().max(200).optional(),
  trackingNumber: z.string().max(200).optional(),
  confirmNoCard: z.boolean(),
});

export async function markShippedAction(input: z.input<typeof markShippedSchema>): Promise<ActionResult> {
  const session = await requirePermission("orders.manage");
  const parsed = markShippedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    if (!parsed.data.confirmNoCard) {
      // Web checkout orders never carry a card, so they never need the confirmation.
      const missing = await getOrdersMissingCard([parsed.data.orderId]);
      if (missing.length > 0) {
        throw new ActionError("Pesanan ini belum punya kartu terima kasih. Konfirmasi untuk tetap mengirim.");
      }
    }
    await transitionOrderStatus(parsed.data.orderId, "shipped", session.staffUser.id, undefined, {
      courier: parsed.data.courier || null,
      trackingNumber: parsed.data.trackingNumber || null,
    });
    revalidateAdmin("/packing", "/orders", "/stock");
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
      const missing = await getOrdersMissingCard(parsed.data.orderIds);
      if (missing.length > 0) {
        throw new ActionError("Sebagian pesanan ini belum punya kartu terima kasih. Konfirmasi untuk tetap mengirim.");
      }
    }
    // Bulk has no resi field: a web checkout order is shipped one by one with its courier and resi
    // (2026-10-21 sandbox run). Refused before anything ships, so a mixed selection changes nothing
    // (transitionOrderStatus would refuse that order anyway, but only after the ones before it).
    const checkoutOrderNos = await getCheckoutOrderNos(parsed.data.orderIds);
    if (checkoutOrderNos.length > 0) {
      throw new ActionError(`${checkoutOrderNos.join(", ")} pesanan website: perlu nomor resi. Tandai dikirim satu per satu.`);
    }
    // Sequential — transitionOrderStatus is its own transaction per order; nothing here needs
    // (or would benefit from) a single cross-order transaction.
    for (const orderId of parsed.data.orderIds) {
      await transitionOrderStatus(orderId, "shipped", session.staffUser.id);
    }
    revalidateAdmin("/packing", "/orders", "/stock");
    return undefined;
  });
}

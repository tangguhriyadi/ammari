"use server";

import { z } from "zod";
import {
  SHIPMENT_CANCEL_REASON_CODES,
  bookShipment,
  cancelShipment,
  recheckBooking,
  refreshShipmentForLabel,
  findLiveShipment,
  type ShipmentActionOutcome,
} from "@ammari/commerce/shipping";
import type { ShipmentCancelReasonCode } from "@ammari/commerce/shipping";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { ActionError } from "@/lib/errors";
import { defaultDb } from "@/lib/db";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { getAdminShipmentRuntime } from "@/lib/shipping/runtime";
import { LABEL_UNAVAILABLE_TEXT, LABEL_WARNING_TEXT, loadLabelSources } from "@/lib/shipping/label-data";
import { LabelBarcodeError, buildShippingLabelPdf, shippingLabelPdfFilename } from "@/lib/shipping/label-pdf";

// Courier booking from /packing and /orders/[id] (docs/plans/cart-checkout.md §15 Phase K, K2).
// orders.manage, checked here on the server for every action; the rules themselves (paid web order
// in to_ship, one live booking, cancel before pickup) run in @ammari/commerce under the order lock.

const orderIdSchema = z.object({ orderId: z.string().uuid() });

/** The booked courier cost is a cost figure: only for finance.view_profit (like the order page). */
function withoutCostUnlessAllowed(result: ActionResult<ShipmentActionOutcome>, permissionKeys: readonly string[]): ActionResult<ShipmentActionOutcome> {
  if (!result.ok || result.data.outcome !== "booked" || permissionKeys.includes("finance.view_profit")) return result;
  return { ok: true, data: { ...result.data, costAmount: null } };
}

function invalid(): ActionResult<never> {
  return { ok: false, error: "Input tidak valid." };
}

export async function bookShipmentAction(input: z.input<typeof orderIdSchema>): Promise<ActionResult<ShipmentActionOutcome>> {
  const session = await requirePermission("orders.manage");
  const parsed = orderIdSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const result = await runAction(() => bookShipment(defaultDb, getAdminShipmentRuntime(), parsed.data.orderId, session.staffUser.id));
  // A refusal may still have recorded a failed attempt, so refresh either way.
  revalidateAdmin("/packing", "/orders");
  return withoutCostUnlessAllowed(result, session.permissionKeys);
}

export async function recheckBookingAction(input: z.input<typeof orderIdSchema>): Promise<ActionResult<ShipmentActionOutcome>> {
  const session = await requirePermission("orders.manage");
  const parsed = orderIdSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const result = await runAction(() => recheckBooking(defaultDb, getAdminShipmentRuntime(), parsed.data.orderId, session.staffUser.id));
  revalidateAdmin("/packing", "/orders");
  return withoutCostUnlessAllowed(result, session.permissionKeys);
}

const cancelSchema = orderIdSchema.extend({ reasonCode: z.enum(SHIPMENT_CANCEL_REASON_CODES as [ShipmentCancelReasonCode, ...ShipmentCancelReasonCode[]]) });

export async function cancelShipmentAction(input: z.input<typeof cancelSchema>): Promise<ActionResult<ShipmentActionOutcome>> {
  const session = await requirePermission("orders.manage");
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const result = await runAction(() =>
    cancelShipment(defaultDb, getAdminShipmentRuntime(), parsed.data.orderId, { reasonCode: parsed.data.reasonCode }, session.staffUser.id),
  );
  revalidateAdmin("/packing", "/orders");
  return withoutCostUnlessAllowed(result, session.permissionKeys);
}

export interface ShippingLabelResult {
  filename: string;
  /** Base64 PDF bytes, decoded into a Blob by the client (same route as the sticker sheets). */
  pdfBase64: string;
  /** What is not printed exactly (Indonesian), shown before the download; empty when exact. */
  warnings: string[];
}

/** "Cetak label": our own 120 x 100 mm label for one booked order. A booked attempt without a
 * routing code is read once first (best effort). */
export async function printShippingLabelAction(input: z.input<typeof orderIdSchema>): Promise<ActionResult<ShippingLabelResult>> {
  await requirePermission("orders.manage");
  const parsed = orderIdSchema.safeParse(input);
  if (!parsed.success) return invalid();
  return runAction(async () => {
    const runtime = getAdminShipmentRuntime();
    if (!runtime) throw new ActionError("Pemesanan kurir belum dikonfigurasi di admin, jadi label belum bisa dibuat.");
    const live = await findLiveShipment(defaultDb, parsed.data.orderId);
    const current = live ? await refreshShipmentForLabel(defaultDb, runtime, live.id) : true;
    const [source] = await loadLabelSources([parsed.data.orderId], runtime);
    if (!source) throw new ActionError(LABEL_UNAVAILABLE_TEXT.not_found);
    if (!source.ok) throw new ActionError(LABEL_UNAVAILABLE_TEXT[source.reason]);
    let built: Awaited<ReturnType<typeof buildShippingLabelPdf>>;
    try {
      built = await buildShippingLabelPdf([source.data]);
    } catch (error) {
      if (error instanceof LabelBarcodeError) {
        console.warn("[shipping] label barcode refused", { orderNo: source.orderNo, reason: error.reason });
        throw new ActionError("Nomor resi ini tidak bisa dicetak sebagai barcode di label kita. Cetak label dari dashboard Biteship.");
      }
      throw error;
    }
    revalidateAdmin("/packing", "/orders");
    return {
      filename: shippingLabelPdfFilename(new Date()),
      pdfBase64: Buffer.from(built.pdf).toString("base64"),
      warnings: [
        ...(current ? [] : ["Data resi belum bisa diperbarui dari Biteship (kode rute mungkin kosong). Cek nomor resi sebelum dicetak."]),
        ...(built.warnings[0] ?? []).map((warning) => LABEL_WARNING_TEXT[warning]),
      ],
    };
  });
}

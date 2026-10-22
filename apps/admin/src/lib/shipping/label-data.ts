import "server-only";
import { and, inArray, notInArray, sql } from "drizzle-orm";
import { orderItems, orders, shipments } from "@ammari/db/schema";
import type { ShipmentRuntime } from "@ammari/commerce/shipping";
import { defaultDb, type Database } from "@/lib/db";
import type { LabelWarning, ShippingLabelData } from "./label-pdf";

// What goes on our own 120 x 100 mm label (docs/plans/cart-checkout.md §15 Phase K, decision 49):
// the order's live booked shipment (waybill, routing code), its locked service and weight, Ammari as
// sender (the shipment runtime's BITESHIP_SHIPPER_*) and the recipient from the order's address
// snapshot. Never the buyer's email.

export type LabelUnavailableReason = "not_found" | "not_booked" | "no_waybill" | "no_address";

export type LabelSource = { orderId: string; orderNo: string } & ({ ok: true; data: ShippingLabelData } | { ok: false; reason: LabelUnavailableReason });

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function loadLabelSources(orderIds: string[], runtime: ShipmentRuntime, db: Database = defaultDb): Promise<LabelSource[]> {
  if (orderIds.length === 0) return [];
  const orderRows = await db.select().from(orders).where(inArray(orders.id, orderIds));
  const shipmentRows = await db
    .select()
    .from(shipments)
    .where(and(inArray(shipments.orderId, orderIds), notInArray(shipments.status, ["cancelled", "failed"])));
  const pieceRows = await db
    .select({ orderId: orderItems.orderId, pieces: sql<number>`coalesce(sum(${orderItems.qty}), 0)::int` })
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .groupBy(orderItems.orderId);

  return orderIds.map((orderId): LabelSource => {
    const order = orderRows.find((row) => row.id === orderId);
    if (!order) return { orderId, orderNo: "-", ok: false, reason: "not_found" };
    const base = { orderId, orderNo: order.orderNo };
    const shipment = shipmentRows.find((row) => row.orderId === orderId);
    if (!shipment || shipment.status === "booking") return { ...base, ok: false, reason: "not_booked" };
    if (!shipment.awb) return { ...base, ok: false, reason: "no_waybill" };
    const snapshot = (order.shippingAddressSnapshot ?? {}) as Record<string, unknown>;
    const name = text(snapshot.recipientName);
    const phone = text(snapshot.phone);
    const address = text(snapshot.addressLine);
    const pieces = pieceRows.find((row) => row.orderId === orderId)?.pieces ?? 0;
    if (!name || !phone || !address || !order.shippingWeightGrams || !order.shippingCourierLabel || pieces <= 0) {
      return { ...base, ok: false, reason: "no_address" };
    }
    const area = [text(snapshot.district), text(snapshot.city), [text(snapshot.province), text(snapshot.postalCode)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return {
      ...base,
      ok: true,
      data: {
        orderNo: order.orderNo,
        courierLabel: order.shippingCourierLabel,
        waybill: shipment.awb,
        routingCode: shipment.routingCode,
        weightGrams: order.shippingWeightGrams,
        pieces,
        sender: { name: runtime.origin.name, phone: runtime.origin.phone, address: runtime.origin.address },
        recipient: { name, phone, address, areaLine: area || null },
        note: text(snapshot.notes),
      },
    };
  });
}

/** Indonesian, for the dialog shown before a label with warnings is downloaded. */
export const LABEL_WARNING_TEXT: Record<LabelWarning, string> = {
  characters_replaced: "Ada huruf yang tidak bisa dicetak, diganti tanda tanya.",
  recipient_name_cut: "Nama penerima dipotong.",
  recipient_address_cut: "Alamat penerima dipotong.",
  recipient_area_cut: "Kecamatan dan kota penerima dipotong.",
  sender_cut: "Data pengirim dipotong.",
  note_cut: "Catatan untuk kurir dipotong.",
};

export const LABEL_UNAVAILABLE_TEXT: Record<LabelUnavailableReason, string> = {
  not_found: "Pesanan tidak ditemukan.",
  not_booked: "Kurir belum dipesan (atau pemesanan belum pasti).",
  no_waybill: "Belum ada nomor resi dari kurir. Tekan Cek ulang pemesanan.",
  no_address: "Data alamat atau ongkir pesanan tidak lengkap.",
};

import "server-only";
import { and, eq } from "drizzle-orm";
import { customerAddresses, shippingAreas } from "@ammari/db/schema";
import { formatShippingAreaLabel } from "@ammari/commerce/shipping-rules";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";

// "Alamat tersimpan" on /account (docs/plans/cart-checkout.md, session 18 follow-up of "Sandbox
// fixes, round 2" item 3): the buyer sees the saved default address placeOrder keeps and deletes it
// themselves, as the privacy policy promises. Only the session's own rows: every query is keyed by
// the customer id the server read from the session, and the page never receives a row id (the
// delete takes none). Orders keep their own address snapshot and are never touched.

/** The saved default address as the /account section shows it (read-only, no ids). */
export interface SavedAddressSummary {
  recipientName: string;
  phone: string;
  addressLine: string;
  notes: string | null;
  /** "Kecamatan, Kota, Provinsi 12345". */
  areaLabel: string;
}

export async function loadSavedAddressSummary(customerId: string, db: Database = defaultDb): Promise<SavedAddressSummary | null> {
  const [row] = await db
    .select({
      recipientName: customerAddresses.recipientName,
      phone: customerAddresses.phone,
      addressLine: customerAddresses.addressLine,
      notes: customerAddresses.notes,
      province: customerAddresses.province,
      city: customerAddresses.city,
      district: customerAddresses.district,
      subdistrict: customerAddresses.subdistrict,
      postalCode: customerAddresses.postalCode,
      areaLabel: shippingAreas.label,
      areaPostalCode: shippingAreas.postalCode,
    })
    .from(customerAddresses)
    .leftJoin(shippingAreas, eq(shippingAreas.id, customerAddresses.shippingAreaId))
    .where(and(eq(customerAddresses.customerId, customerId), eq(customerAddresses.isDefault, true)))
    .limit(1);
  if (!row) return null;
  // The area's own label when it has one (as checkout shows it), else built from the row's names;
  // the kode pos the buyer typed is added when the area carries none.
  const label =
    row.areaLabel ??
    formatShippingAreaLabel({ province: row.province, city: row.city, district: row.district, subdistrict: row.subdistrict, postalCode: row.areaPostalCode ?? row.postalCode });
  const typedPostalCode = row.areaLabel !== null && row.areaPostalCode === null ? ` ${row.postalCode}` : "";
  return {
    recipientName: row.recipientName,
    phone: row.phone,
    addressLine: row.addressLine,
    notes: row.notes,
    areaLabel: label + typedPostalCode,
  };
}

/** Deletes every saved address of the customer (today at most the one default) in one transaction:
 * one `DELETE ... WHERE customer_id = <session customer> RETURNING id`, then an audit row with only
 * the count, never the address. Deleting nothing (a second "Hapus", another tab) is
 * not an error and writes no audit row. Returns how many rows went. */
export async function deleteSavedAddresses(customerId: string, db: Database = defaultDb): Promise<number> {
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(customerAddresses).where(eq(customerAddresses.customerId, customerId)).returning({ id: customerAddresses.id });
    if (deleted.length === 0) return 0;
    await writeAuditLog(tx, {
      action: "customer_address_deleted",
      entityType: "customer",
      entityId: customerId,
      after: { deletedCount: deleted.length, by: "customer" },
    });
    return deleted.length;
  });
}

/** Per IP (`saved_address_delete` on claim_rate_limits): a real buyer presses "Hapus alamat" once;
 * this only brakes a script replaying the action. Generous because many buyers share one carrier
 * CGNAT address (same reasoning as the cart limits) and a deletion the privacy policy promises
 * should not be refused for a neighbour's presses. A per-customer key adds nothing: each call can
 * only delete the caller's own rows. */
export const SAVED_ADDRESS_DELETE_WINDOW_SECONDS = 10 * 60;
export const SAVED_ADDRESS_DELETE_LIMIT = 30;

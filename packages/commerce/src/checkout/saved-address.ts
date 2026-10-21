import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { customerAddresses } from "@ammari/db/schema";
import type { ShippingAddress } from "../address";
import type { Database } from "../db";

/** The saved default a replacement may overwrite, as the caller read it. */
export interface SavedAddressVersion {
  id: string;
  recipientName: string;
  phone: string;
  addressLine: string;
  notes: string | null;
  shippingAreaId: string | null;
  postalCode: string;
}

/** Makes `address` the customer's default saved address (plan §4.3; owner, 2026-10-21: "saved
 * address"), replaced in place by one INSERT ... ON CONFLICT on the partial UNIQUE (customer_id)
 * WHERE is_default, so the default switches atomically and two writes at once just apply one after
 * the other. Used by placeOrder for a session customer and by the /account offer to keep a guest
 * order's address. `replace: false` only adds a first default: a default that exists (or appeared
 * meanwhile) is kept, and false is returned. `onlyOver` replaces only that exact default (its id and
 * the fields a buyer can change, compared in the conflict's WHERE), so a default changed meanwhile
 * is kept and false is returned. Not `updated_at`: its trigger writes the transaction's now(), so it
 * does not tell two writes in one transaction apart. Errors propagate: each caller decides what a
 * refused row costs. */
export async function saveDefaultCustomerAddress(
  db: Database,
  customerId: string,
  address: ShippingAddress,
  options: { replace: false } | { replace: true; onlyOver?: SavedAddressVersion } = { replace: true },
): Promise<boolean> {
  const fields = {
    recipientName: address.recipientName,
    phone: address.phone,
    addressLine: address.addressLine,
    notes: address.notes,
    shippingAreaId: address.shippingAreaId,
    province: address.province,
    city: address.city,
    district: address.district,
    subdistrict: address.subdistrict,
    postalCode: address.postalCode,
    // Checkout has no map pin: coordinates of an earlier address never stay on a new one.
    latitude: null,
    longitude: null,
  };
  const insert = db.insert(customerAddresses).values({ customerId, ...fields, isDefault: true });
  const written = options.replace
    ? await insert
        .onConflictDoUpdate({
          target: customerAddresses.customerId,
          targetWhere: sql`${customerAddresses.isDefault}`,
          set: { ...fields, updatedAt: sql`now()` },
          ...(options.onlyOver
            ? {
                setWhere: and(
                  eq(customerAddresses.id, options.onlyOver.id),
                  eq(customerAddresses.recipientName, options.onlyOver.recipientName),
                  eq(customerAddresses.phone, options.onlyOver.phone),
                  eq(customerAddresses.addressLine, options.onlyOver.addressLine),
                  sql`${customerAddresses.notes} is not distinct from ${options.onlyOver.notes}`,
                  sql`${customerAddresses.shippingAreaId} is not distinct from ${options.onlyOver.shippingAreaId}`,
                  eq(customerAddresses.postalCode, options.onlyOver.postalCode),
                ),
              }
            : {}),
        })
        .returning({ id: customerAddresses.id })
    : await insert
        .onConflictDoNothing({ target: customerAddresses.customerId, where: sql`${customerAddresses.isDefault}` })
        .returning({ id: customerAddresses.id });
  return written.length > 0;
}

import "server-only";
import { ilike, or } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { FieldError, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, type Database } from "@/lib/db";

export interface CustomerOption {
  id: string;
  name: string;
  phone: string | null;
}

/** Search existing customers by name or phone, for the /orders/new "pick existing customer"
 * picker. Capped at 20 — a typeahead result list, not a paginated browse view. */
export async function searchCustomers(q: string, db: Database = defaultDb): Promise<CustomerOption[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];
  const rows = await db
    .select({ id: customers.id, name: customers.name, phone: customers.phone })
    .from(customers)
    .where(or(ilike(customers.name, `%${trimmed}%`), ilike(customers.phone, `%${trimmed}%`)))
    .orderBy(customers.name)
    .limit(20);
  return rows;
}

export interface CreateCustomerInput {
  name: string;
  /** +62-prefixed, 8-13 digits — same format customers_phone_format_check enforces; validated
   * again here so a bad value surfaces as a FieldError, not a raw Postgres CHECK violation. */
  phone?: string | null;
}

/** Creates a customer from manual order entry — name + optional phone ONLY. No email, no PDP
 * consent: both are nullable as of migration 0011 specifically for this path (see customers.ts's
 * doc comments on those two columns) — a staff-created customer has given no consent, and stays
 * that way until the buyer later self-serves (a voucher claim or main-site signup). Address is
 * NOT collected here — it lives on the order itself (orders.shippingAddress), not the customer,
 * same reasoning orders.buyerUsername already follows. */
export async function createCustomer(input: CreateCustomerInput, db: Database = defaultDb) {
  const phone = input.phone?.trim() || null;
  if (phone && !/^\+62[0-9]{8,13}$/.test(phone)) {
    throw new FieldError("phone", "Format nomor HP tidak valid (gunakan +62...).");
  }
  try {
    const [customer] = await db
      .insert(customers)
      .values({ name: input.name.trim(), phone, pdpConsentAt: null, email: null })
      .returning();
    if (!customer) throw new Error("failed to insert customer");
    return customer;
  } catch (error) {
    mapUniqueViolation(error, {
      customers_phone_unique: { field: "phone", message: "Nomor HP ini sudah terdaftar pada pelanggan lain." },
    });
  }
}

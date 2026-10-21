import "server-only";
import { and, desc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { customers, orders } from "@ammari/db/schema";
import { CUSTOMER_PLACEHOLDER_NAME } from "@ammari/auth/customer";
import { defaultDb, type Database } from "@/lib/db";
import { isUniqueViolation } from "@/lib/errors";
import { visibleToCustomerSql } from "@/lib/orders/access";
import { parseAccountName } from "./name";

// The /account offer to copy contact details from guest orders (docs/plans/cart-checkout.md §5 step
// 4, §9.3; owner decision 2026-10-21, session 14). A guest checkout records the buyer's WhatsApp
// number and promo choice only on the order (the email was unverified then). After any verified
// login the account page offers them, never copies them by itself: anyone can type someone else's
// email at checkout, so the account owner confirms the number, and ticks the promo consent again.
//
// Offered from the newest guest checkout order of the customer placed after their last answer
// (`customers.contact_offer_resolved_at`): the number only while the account has none and no other
// account uses it; promo only while the account has no promo consent and the order opted in. Only
// an order "Pesanan saya" shows the account (lib/orders/access.ts, session 15): a guest order typed
// with an email the account no longer has is never offered. Since the 2026-10-21 sandbox run also
// the order's recipient name, only while the account still has the placeholder name (an OTP login
// carries none); a ticked box saves it, never the offer alone.

export interface ContactOffer {
  orderNo: string;
  orderDate: Date;
  /** "+62...", or null when there is no number to offer. */
  phone: string | null;
  /** The order opted in to promotions and the account has no promo consent yet. */
  promo: boolean;
  /** The order's recipient name, offered while the account name is still the placeholder; null
   * otherwise. */
  name: string | null;
}

export async function loadContactOffer(customerId: string, db: Database = defaultDb): Promise<ContactOffer | null> {
  const [customer] = await db
    .select({ name: customers.name, phone: customers.phone, promoConsentAt: customers.promoConsentAt, resolvedAt: customers.contactOfferResolvedAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const placeholderName = customer?.name === CUSTOMER_PLACEHOLDER_NAME;
  if (!customer || (customer.phone !== null && customer.promoConsentAt !== null && !placeholderName)) return null;

  const [order] = await db
    .select({ orderNo: orders.orderNo, orderDate: orders.orderDate, contactPhone: orders.contactPhone, promoOptIn: orders.promoOptIn, recipientName: orders.recipientName })
    .from(orders)
    .where(
      and(
        visibleToCustomerSql(customerId),
        isNotNull(orders.paymentStatus),
        eq(orders.placedWithSession, false),
        ...(customer.resolvedAt ? [gt(orders.createdAt, customer.resolvedAt)] : []),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(1);
  if (!order) return null;

  let phone: string | null = null;
  // Only a number the account column accepts (customers_phone_format_check).
  if (customer.phone === null && order.contactPhone && /^\+62[0-9]{8,13}$/.test(order.contactPhone)) {
    const holder = alias(customers, "phone_holder");
    const [taken] = await db
      .select({ id: holder.id })
      .from(holder)
      .where(and(eq(holder.phone, order.contactPhone), ne(holder.id, customerId)))
      .limit(1);
    if (!taken) phone = order.contactPhone;
  }
  const promo = customer.promoConsentAt === null && order.promoOptIn === true;
  const recipient = placeholderName ? parseAccountName(order.recipientName) : null;
  const name = recipient?.ok && recipient.name !== CUSTOMER_PLACEHOLDER_NAME ? recipient.name : null;
  if (!phone && !promo && !name) return null;
  return { orderNo: order.orderNo, orderDate: order.orderDate, phone, promo, name };
}

/** "Simpan" names the offer it answers (the order and number the buyer saw), so a different offer
 * that appeared meanwhile (another guest order typed with this email) is never saved unseen. */
export type ContactOfferAnswer =
  | { kind: "save"; promo: boolean; useName: boolean; seen: { orderNo: string; phone: string | null; name: string | null } }
  | { kind: "skip" };
export type ContactOfferResult = { ok: true } | { ok: false; message: string };

export const CONTACT_OFFER_GONE = "Data pesanan ini sudah tidak bisa disimpan. Isi nomor di profil kalau perlu.";
export const CONTACT_OFFER_CHANGED = "Data pesanan berubah. Muat ulang halaman ini lalu cek lagi.";
export const CONTACT_OFFER_PHONE_TAKEN = "Nomor ini sudah dipakai akun lain. Pilih Lewati, lalu isi nomor lain di profil.";

/** Applies the answer to the offer as it stands now (re-read here, never taken from the browser).
 * One UPDATE: the number only where the account still has none (the UNIQUE constraint decides a
 * race for the number), promo consent only when ticked and still missing, the order's recipient
 * name only when ticked and the account name is still the placeholder, and the answer stamped so
 * this order is not offered again. A taken number writes nothing. */
export async function answerContactOffer(customerId: string, answer: ContactOfferAnswer, db: Database = defaultDb): Promise<ContactOfferResult> {
  const offer = await loadContactOffer(customerId, db);
  // Gone since the card was shown (the number was taken meanwhile, or another tab answered): say so
  // rather than report a save that wrote nothing.
  if (!offer && answer.kind === "save") return { ok: false, message: CONTACT_OFFER_GONE };
  if (offer && answer.kind === "save" && (offer.orderNo !== answer.seen.orderNo || offer.phone !== answer.seen.phone || offer.name !== answer.seen.name)) {
    return { ok: false, message: CONTACT_OFFER_CHANGED };
  }
  if (!offer || answer.kind === "skip") {
    await db.update(customers).set({ contactOfferResolvedAt: sql`clock_timestamp()` }).where(eq(customers.id, customerId));
    return { ok: true };
  }
  const stampPromo = answer.promo && offer.promo;
  const newName = answer.useName ? offer.name : null;
  try {
    await db
      .update(customers)
      .set({
        // Only over the placeholder: a name the buyer set meanwhile (another tab) is never replaced.
        name: newName ? sql`case when ${customers.name} = ${CUSTOMER_PLACEHOLDER_NAME} then ${newName} else ${customers.name} end` : sql`${customers.name}`,
        phone: offer.phone ? sql`coalesce(${customers.phone}, ${offer.phone})` : sql`${customers.phone}`,
        promoConsentAt: stampPromo ? sql`coalesce(${customers.promoConsentAt}, now())` : sql`${customers.promoConsentAt}`,
        contactOfferResolvedAt: sql`clock_timestamp()`,
      })
      .where(eq(customers.id, customerId));
  } catch (error) {
    if (isUniqueViolation(error, "customers_phone_unique")) return { ok: false, message: CONTACT_OFFER_PHONE_TAKEN };
    throw error;
  }
  return { ok: true };
}

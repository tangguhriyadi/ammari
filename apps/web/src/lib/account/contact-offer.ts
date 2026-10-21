import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { customerAddresses, customers, orders, shippingAreas } from "@ammari/db/schema";
import { CUSTOMER_PLACEHOLDER_NAME } from "@ammari/auth/customer";
import { parseShippingAddress, type ShippingAddress } from "@ammari/commerce/address";
import { saveDefaultCustomerAddress, type SavedAddressVersion } from "@ammari/commerce/checkout";
import { formatShippingAreaLabel } from "@ammari/commerce/shipping-rules";
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
//
// Since the 2026-10-22 dev feedback also the order's shipping address (a guest order never saves
// one, so the next checkout after a login started empty): rebuilt from the order's snapshot against
// the area row as it is now, skipped when the area no longer resolves (gone, or no provider id to
// quote) or when it equals the saved default already. Saved as the default address only when
// ticked, and the box always starts unticked (owner decision 2026-10-22: a stranger can type the
// buyer's email at guest checkout, so their address is never one press of "Simpan" away).

/** The order's address as the card shows it (read-only). */
export interface ContactOfferAddress {
  recipientName: string;
  phone: string;
  addressLine: string;
  notes: string | null;
  /** "Kecamatan, Kota, Provinsi 12345". */
  areaLabel: string;
  /** The account has a default address this one would replace (the checkbox label says so). */
  replacesSaved: boolean;
  /** What the card posts back as the address it showed: "new", or "replace:" plus an opaque key of
   * the saved default (its id and contents), so a default changed in another tab is never replaced
   * unseen. */
  seenKey: string;
}

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
  /** The order's shipping address, or null when there is none to offer. */
  address: ContactOfferAddress | null;
}

/** The address the card showed, as it posts it back (ContactOfferAddress.seenKey), or null. */
export type ContactOfferAddressKind = string | null;

export function contactOfferAddressKind(offer: Pick<ContactOffer, "address"> | null): ContactOfferAddressKind {
  return offer?.address?.seenKey ?? null;
}

/** The shape of a seenKey, for the action to drop anything else the browser sends. */
export const CONTACT_OFFER_SEEN_KEY = /^(new|replace:[0-9a-f]{16})$/;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The order's address as a saved address would hold it: the free fields from the snapshot,
 * validated again with the rules checkout used, against the area row as it is now (`null` when the
 * order's area is gone or has no provider id, so the next checkout could not quote it). */
function addressFromOrder(snapshot: unknown, area: { id: string; province: string; city: string; district: string; subdistrict: string | null; postalCode: string | null; providerAreaId: string | null } | null): ShippingAddress | null {
  if (!area || !snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Record<string, unknown>;
  if (value.version !== 2) return null;
  const parsed = parseShippingAddress(
    { recipientName: text(value.recipientName), phone: text(value.phone), addressLine: text(value.addressLine), notes: text(value.notes), postalCode: text(value.postalCode) },
    area,
  );
  return parsed.ok ? parsed.value : null;
}

interface FoundOffer {
  offer: ContactOffer;
  /** The address to save when ticked; set exactly when `offer.address` is. */
  address: ShippingAddress | null;
  /** The saved default it would replace, or null for a first one. */
  replaces: SavedAddressVersion | null;
}

async function findContactOffer(customerId: string, db: Database): Promise<FoundOffer | null> {
  const [customer] = await db
    .select({ name: customers.name, phone: customers.phone, promoConsentAt: customers.promoConsentAt, resolvedAt: customers.contactOfferResolvedAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customer) return null;
  const placeholderName = customer.name === CUSTOMER_PLACEHOLDER_NAME;

  const [order] = await db
    .select({
      orderNo: orders.orderNo,
      orderDate: orders.orderDate,
      contactPhone: orders.contactPhone,
      promoOptIn: orders.promoOptIn,
      recipientName: orders.recipientName,
      snapshot: orders.shippingAddressSnapshot,
      areaId: shippingAreas.id,
      areaProvince: shippingAreas.province,
      areaCity: shippingAreas.city,
      areaDistrict: shippingAreas.district,
      areaSubdistrict: shippingAreas.subdistrict,
      areaPostalCode: shippingAreas.postalCode,
      areaLabel: shippingAreas.label,
      providerAreaId: shippingAreas.providerAreaId,
    })
    .from(orders)
    .leftJoin(shippingAreas, eq(shippingAreas.id, orders.shippingAreaId))
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

  const area =
    order.areaId && order.areaProvince && order.areaCity && order.areaDistrict
      ? {
          id: order.areaId,
          province: order.areaProvince,
          city: order.areaCity,
          district: order.areaDistrict,
          subdistrict: order.areaSubdistrict,
          postalCode: order.areaPostalCode,
          label: order.areaLabel,
          providerAreaId: order.providerAreaId,
        }
      : null;
  let address = addressFromOrder(order.snapshot, area);
  let offeredAddress: ContactOfferAddress | null = null;
  let replaces: FoundOffer["replaces"] = null;
  if (address && area) {
    const [saved] = await db
      .select({
        id: customerAddresses.id,
        recipientName: customerAddresses.recipientName,
        phone: customerAddresses.phone,
        addressLine: customerAddresses.addressLine,
        notes: customerAddresses.notes,
        shippingAreaId: customerAddresses.shippingAreaId,
        postalCode: customerAddresses.postalCode,
      })
      .from(customerAddresses)
      .where(and(eq(customerAddresses.customerId, customerId), eq(customerAddresses.isDefault, true)))
      .limit(1);
    const same =
      saved &&
      saved.recipientName === address.recipientName &&
      saved.phone === address.phone &&
      saved.addressLine === address.addressLine &&
      (saved.notes ?? null) === address.notes &&
      saved.shippingAreaId === address.shippingAreaId &&
      saved.postalCode === address.postalCode;
    if (same) {
      address = null;
    } else {
      replaces = saved ?? null;
      offeredAddress = {
        recipientName: address.recipientName,
        phone: address.phone,
        addressLine: address.addressLine,
        notes: address.notes,
        areaLabel:
          (area.label ?? formatShippingAreaLabel({ province: area.province, city: area.city, district: area.district, subdistrict: area.subdistrict, postalCode: area.postalCode })) +
          (area.postalCode ? "" : ` ${address.postalCode}`),
        replacesSaved: replaces !== null,
        seenKey: replaces ? `replace:${createHash("sha256").update(JSON.stringify(replaces)).digest("hex").slice(0, 16)}` : "new",
      };
    }
  }

  if (!phone && !promo && !name && !offeredAddress) return null;
  return {
    offer: { orderNo: order.orderNo, orderDate: order.orderDate, phone, promo, name, address: offeredAddress },
    address: offeredAddress ? address : null,
    replaces: offeredAddress ? replaces : null,
  };
}

export async function loadContactOffer(customerId: string, db: Database = defaultDb): Promise<ContactOffer | null> {
  return (await findContactOffer(customerId, db))?.offer ?? null;
}

/** "Simpan" names the offer it answers (the order, number, name and kind of address the buyer saw),
 * so a different offer that appeared meanwhile (another guest order typed with this email, an
 * address saved by a checkout in another tab) is never saved unseen. */
export type ContactOfferAnswer =
  | {
      kind: "save";
      promo: boolean;
      useName: boolean;
      useAddress: boolean;
      seen: { orderNo: string; phone: string | null; name: string | null; address: ContactOfferAddressKind };
    }
  | { kind: "skip" };
export type ContactOfferResult = { ok: true } | { ok: false; message: string };

export const CONTACT_OFFER_GONE = "Data pesanan ini sudah tidak bisa disimpan. Isi nomor di profil kalau perlu.";
export const CONTACT_OFFER_CHANGED = "Data pesanan berubah. Muat ulang halaman ini lalu cek lagi.";
export const CONTACT_OFFER_PHONE_TAKEN = "Nomor ini sudah dipakai akun lain. Pilih Lewati, lalu isi nomor lain di profil.";

/** The default address changed between the re-read and the write (one appeared for a "new"
 * address, or the one to replace was changed), or the table refused the address row. */
class AddressChangedError extends Error {}

/** Applies the answer to the offer as it stands now (re-read here, never taken from the browser).
 * One UPDATE: the number only where the account still has none (the UNIQUE constraint decides a
 * race for the number), promo consent only when ticked and still missing, the order's recipient
 * name only when ticked and the account name is still the placeholder, and the answer stamped so
 * this order is not offered again. A ticked address is written in the same transaction as that
 * UPDATE (saveDefaultCustomerAddress, the atomic default switch placeOrder uses): a first default
 * only while there still is none, a replacement only over the exact default the card showed. A
 * taken number, or a default that appeared or changed meanwhile, writes nothing. */
export async function answerContactOffer(customerId: string, answer: ContactOfferAnswer, db: Database = defaultDb): Promise<ContactOfferResult> {
  const found = await findContactOffer(customerId, db);
  const offer = found?.offer ?? null;
  // Gone since the card was shown (the number was taken meanwhile, or another tab answered): say so
  // rather than report a save that wrote nothing.
  if (!offer && answer.kind === "save") return { ok: false, message: CONTACT_OFFER_GONE };
  if (
    offer &&
    answer.kind === "save" &&
    (offer.orderNo !== answer.seen.orderNo || offer.phone !== answer.seen.phone || offer.name !== answer.seen.name || contactOfferAddressKind(offer) !== answer.seen.address)
  ) {
    return { ok: false, message: CONTACT_OFFER_CHANGED };
  }
  if (!offer || answer.kind === "skip") {
    await db.update(customers).set({ contactOfferResolvedAt: sql`clock_timestamp()` }).where(eq(customers.id, customerId));
    return { ok: true };
  }
  const stampPromo = answer.promo && offer.promo;
  const newName = answer.useName ? offer.name : null;
  const address = answer.useAddress && offer.address ? found?.address ?? null : null;
  const replaces = found?.replaces ?? null;

  const writeCustomer = (target: Database) =>
    target
      .update(customers)
      .set({
        // Only over the placeholder: a name the buyer set meanwhile (another tab) is never replaced.
        name: newName ? sql`case when ${customers.name} = ${CUSTOMER_PLACEHOLDER_NAME} then ${newName} else ${customers.name} end` : sql`${customers.name}`,
        phone: offer.phone ? sql`coalesce(${customers.phone}, ${offer.phone})` : sql`${customers.phone}`,
        promoConsentAt: stampPromo ? sql`coalesce(${customers.promoConsentAt}, now())` : sql`${customers.promoConsentAt}`,
        contactOfferResolvedAt: sql`clock_timestamp()`,
      })
      .where(eq(customers.id, customerId));
  try {
    if (address) {
      await db.transaction(async (tx) => {
        await writeCustomer(tx);
        let written: boolean;
        try {
          written = await saveDefaultCustomerAddress(tx, customerId, address, replaces ? { replace: true, onlyOver: replaces } : { replace: false });
        } catch (error) {
          // Data the table refuses (a CHECK, a vanished area: 22xxx and 23xxx) is reported like a
          // change, and the whole answer rolls back; anything else (the connection) still throws.
          const cause = (error instanceof Error && error.cause !== undefined ? error.cause : error) as { code?: unknown } | null;
          const code = typeof cause?.code === "string" ? cause.code : "";
          if (!code.startsWith("22") && !code.startsWith("23")) throw error;
          console.warn("[account] the order's address was refused by customer_addresses; nothing saved", { customerId, code });
          written = false;
        }
        if (!written) throw new AddressChangedError();
      });
    } else {
      await writeCustomer(db);
    }
  } catch (error) {
    if (error instanceof AddressChangedError) return { ok: false, message: CONTACT_OFFER_CHANGED };
    if (isUniqueViolation(error, "customers_phone_unique")) return { ok: false, message: CONTACT_OFFER_PHONE_TAKEN };
    throw error;
  }
  return { ok: true };
}

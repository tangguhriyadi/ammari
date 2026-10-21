import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  cartItems,
  carts,
  customers,
  fabricColors,
  orderAccessTokens,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
  vouchers,
} from "@ammari/db/schema";
import {
  formatShippingAddress,
  normalizeIndonesianPhone,
  parseShippingAddress,
  toShippingAddressSnapshot,
  type ShippingAddress,
} from "../address";
import { resolveCart, type CartIdentity } from "../cart/cart";
import { CART_MAX_PIECES, CART_MAX_QTY_PER_LINE } from "../cart/limits";
import { writeAuditLog, type Database, type Tx } from "../db";
import { FieldError, isPostgresConstraintViolation, isPostgresErrorCode } from "../errors";
import { generateOrderNumber } from "../orders/order-number";
import type { PaymentRuntime } from "../payments/config";
import { buildPaymentLines, providerOrderId } from "../payments/lines";
import { PAYMENT_PAGE_TIMEOUT_MS, requestPaymentPage } from "../payments/attempts";
import { loadShippingArea } from "../shipping/areas";
import { quoteShipping, type QuoteLine, type ShippingQuote, type ShippingQuoteDeps, type ShippingQuoteRefusal } from "../shipping/quote";
import { parcelWeightGrams } from "../shipping/rules";
import { reserveStockForOrder } from "../stock/reservations";
import { ORDER_ACCESS_TOKEN_DAYS, generateOrderAccessToken, hashOrderAccessToken, isWellFormedOrderAccessToken } from "./access-token";
import { saveDefaultCustomerAddress } from "./saved-address";
import {
  CHECKOUT_FIELD_MESSAGES,
  MAX_UNPAID_ORDERS_PER_EMAIL,
  PLACE_ORDER_MESSAGES,
  UNPAID_ORDER_WINDOW_MINUTES,
  type PlaceOrderRefusal,
} from "./messages";

// placeOrder (docs/plans/cart-checkout.md §5, D3, D9, D10, D17): turns the buyer's cart into an
// `awaiting_payment` checkout order with its stock held, its shipping quote locked and one payment
// attempt, then asks the payment provider for a payment page. The browser is trusted only for the
// cart identity, the form fields, the chosen voucher id, the consent booleans, a per-page-load
// `checkoutAttemptId` and an `expectedTotal` used only to detect drift; every price, the ongkir,
// the discount and the stock are decided here.
//
// Order of work:
// 1. Validate (contact, address against our own shipping_areas row, consent). Nothing written.
// 2. A known `checkoutAttemptId` answers with that order (double submit, plan §5).
// 3. Read the cart (resolveCart merges a guest cart after login first) and quote shipping from
//    those lines, OUTSIDE any transaction (the quote may call the provider; plan §4.5.4).
// 4. One transaction. Lock order, the same as every cart write (cart.ts): the cart row first
//    (FOR NO KEY UPDATE, so a concurrent cart write waits and cannot change the lines being
//    ordered), then an advisory lock for the unpaid-order cap, the customer row, the
//    order-number advisory lock, the product variants (reserveStockForOrder, sorted by SKU) and the
//    voucher row. Never a variant before the cart.
//    The locked lines must be exactly the quoted ones, every product still active and published,
//    and their parcel weight the quote's; otherwise it rolls back with "Isi keranjang berubah".
// 5. After commit: the payment page (payments/attempts.ts). A provider failure keeps the order
//    pending without one; the finish page offers a retry (a new attempt), and the expiry sweep
//    (session 12) cancels it if never paid.
//
// Checkout never signs anyone in (D9): a guest is linked to (or creates) a `customers` row by email,
// but an existing row matched by that unverified email is never changed, and a new one gets only
// the email and a name.

export interface PlaceOrderInput {
  /** The session customer, re-read from `customers` (never the auth payload); null for a guest. */
  customer: { id: string; email: string | null } | null;
  /** sha256 of the guest cart cookie, when the browser has one (merged into a session customer's
   * cart first). */
  guestTokenHash: string | null;
  /** Generated per checkout page load (`orders.checkout_attempt_id`, UNIQUE). */
  checkoutAttemptId: string;
  /** Raw form input. A session customer's email always comes from the session, not from here. */
  contact: { email?: unknown; phone?: unknown };
  /** Raw address fields for parseShippingAddress (recipientName, phone, addressLine, notes,
   * postalCode). */
  address: unknown;
  /** Our own `shipping_areas.id`. */
  shippingAreaId: string;
  voucherId: string | null;
  termsAccepted: boolean;
  promoOptIn: boolean;
  /** The total the buyer saw; only compared, never used as a price. */
  expectedTotal: number;
  /** The raw token from the checkout's order access cookie, if the browser has one. A guest's
   * repeat submit gets the payment page back only with the matching token. */
  orderAccessToken?: string | null;
}

export interface PlaceOrderDeps {
  shipping: ShippingQuoteDeps;
  payment: PaymentRuntime;
  /** The absolute `/checkout/finish?order=<orderNo>` URL the gateway sends the buyer back to. */
  finishUrl: (orderNo: string) => string;
  /** Called once a submit has passed validation and is not a repeat, before the cart is read or
   * the shipping provider asked: the caller's rate limit (`checkout_submit`), so correcting a form
   * never spends it. False refuses with `rate_limited`. */
  admit?: () => Promise<boolean>;
}

export interface PlaceOrderFieldError {
  /** An address or checkout field name, or a SKU for a stock refusal. */
  field: string;
  message: string;
}

type PlaceOrderOutcome =
  | {
      ok: true;
      orderId: string;
      orderNo: string;
      /** The payment page, or null when the provider failed (the finish page offers a retry). */
      redirectUrl: string | null;
      /** The raw order access token for the checkout cookie; null when this answered a repeat
       * submit (the first submit's cookie is already set). */
      accessToken: string | null;
      /** Products whose availability just changed (their pages need revalidating). */
      productSlugs: string[];
      /** A repeat submit of an attempt that already has its order. */
      replayed: boolean;
    }
  | {
      ok: false;
      reason: PlaceOrderRefusal;
      message: string;
      fieldErrors: PlaceOrderFieldError[];
      /** For `shipping_missing_weight`: the SKUs to log. */
      missingSkus?: string[];
    };

/** Both outcomes say whether the guest cart cookie can go: true once resolveCart has merged the
 * guest cart into the session customer's, whatever happened after. */
export type PlaceOrderResult = PlaceOrderOutcome & { clearGuestCookie: boolean };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailSchema = z.email().max(254);

/** Namespace (first key) of the two-key advisory lock taken per unpaid-order cap key (contact email
 * or session customer); the order number's one-key lock lives in a different key space, so they
 * never collide. */
const CONTACT_EMAIL_LOCK_NAMESPACE = 914_201;

/** The payment page request's cap (it runs in the buyer's request after the commit). */
export { PAYMENT_PAGE_TIMEOUT_MS };

/** `lock_timeout` inside the order transaction. */
const ORDER_LOCK_TIMEOUT_SECONDS = 5;

class PlaceOrderRefused extends Error {
  constructor(
    public readonly reason: PlaceOrderRefusal,
    public readonly fieldErrors: PlaceOrderFieldError[] = [],
    message?: string,
  ) {
    super(message ?? PLACE_ORDER_MESSAGES[reason]);
    this.name = "PlaceOrderRefused";
  }
}

function refusal(
  reason: PlaceOrderRefusal,
  fieldErrors: PlaceOrderFieldError[] = [],
  message?: string,
  missingSkus?: string[],
): PlaceOrderOutcome {
  return { ok: false, reason, message: message ?? PLACE_ORDER_MESSAGES[reason], fieldErrors, ...(missingSkus ? { missingSkus } : {}) };
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

interface ValidatedInput {
  contactEmail: string;
  contactPhone: string;
  address: ShippingAddress;
}

/** Every problem at once, in form order (contact, address, consent), so checkout can show one
 * alert listing what to fix (plan §4.3). */
async function validate(db: Database, input: PlaceOrderInput): Promise<{ ok: true; value: ValidatedInput } | { ok: false; errors: PlaceOrderFieldError[] }> {
  const errors: PlaceOrderFieldError[] = [];

  // A session customer's contact email is their account's (plan §4.3: a locked card).
  const rawEmail = input.customer ? input.customer.email : input.contact.email;
  const emailText = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const email = emailSchema.safeParse(emailText);
  if (emailText.length === 0) errors.push({ field: "contactEmail", message: CHECKOUT_FIELD_MESSAGES.emailRequired });
  else if (!email.success) errors.push({ field: "contactEmail", message: CHECKOUT_FIELD_MESSAGES.emailInvalid });

  const phoneText = typeof input.contact.phone === "string" ? input.contact.phone.trim() : "";
  const phone = phoneText.length > 0 ? normalizeIndonesianPhone(phoneText) : null;
  if (phoneText.length === 0) errors.push({ field: "contactPhone", message: CHECKOUT_FIELD_MESSAGES.phoneRequired });
  else if (!phone) errors.push({ field: "contactPhone", message: CHECKOUT_FIELD_MESSAGES.phoneInvalid });

  const area = await loadShippingArea(db, input.shippingAreaId);
  const address = parseShippingAddress(input.address, area);
  if (!address.ok) errors.push(...address.errors);

  if (input.voucherId !== null && !input.customer) errors.push({ field: "voucherId", message: CHECKOUT_FIELD_MESSAGES.voucherNeedsLogin });
  if (input.termsAccepted !== true) errors.push({ field: "termsAccepted", message: CHECKOUT_FIELD_MESSAGES.termsRequired });

  if (errors.length > 0 || !email.success || !phone || !address.ok) return { ok: false, errors };
  return { ok: true, value: { contactEmail: email.data, contactPhone: phone, address: address.value } };
}

/** Same SKU on two rows is impossible today (UNIQUE (cart_id, sku)), but placeOrder must never
 * hand reserveStockForOrder a SKU twice, so lines are folded by SKU first (session 4 note). */
function mergeBySku<T extends QuoteLine>(lines: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const line of lines) {
    const existing = merged.get(line.sku);
    merged.set(line.sku, existing ? { ...existing, qty: existing.qty + line.qty } : { ...line });
  }
  return [...merged.values()];
}

function sameLines(a: readonly QuoteLine[], b: readonly QuoteLine[]): boolean {
  const key = (lines: readonly QuoteLine[]) =>
    lines
      .map((line) => `${line.sku}\u0000${line.qty}`)
      .sort()
      .join("\u0001");
  return key(a) === key(b);
}

async function readCartLines(db: Database, cartId: string): Promise<QuoteLine[]> {
  const rows = await db
    .select({ sku: cartItems.sku, qty: cartItems.qty })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.addedAt), asc(cartItems.sku));
  return mergeBySku(rows);
}

type ExistingOrder = Pick<
  typeof orders.$inferSelect,
  "id" | "orderNo" | "contactEmail" | "customerId" | "placedWithSession" | "status" | "paymentStatus"
>;

async function findOrderByAttempt(db: Database, checkoutAttemptId: string): Promise<ExistingOrder | null> {
  const [row] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      contactEmail: orders.contactEmail,
      customerId: orders.customerId,
      placedWithSession: orders.placedWithSession,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
    })
    .from(orders)
    .where(eq(orders.checkoutAttemptId, checkoutAttemptId))
    .limit(1);
  return row ?? null;
}

/** A repeat submit of an attempt that already has its order answers with that order, but only to
 * the same buyer (same contact email, and the same session customer or again a guest), so an
 * attempt id alone never reveals someone's order. The payment page itself comes back only while
 * the order still awaits payment, and for a guest only with the checkout cookie's matching access
 * token (a lost cookie sends the buyer to the finish page, which offers the email login). */
async function replay(db: Database, order: ExistingOrder, input: PlaceOrderInput, contactEmail: string): Promise<PlaceOrderOutcome> {
  const sameBuyer =
    order.contactEmail?.toLowerCase() === contactEmail &&
    (input.customer ? order.customerId === input.customer.id : order.placedWithSession === false);
  if (!sameBuyer) {
    console.warn("[checkout] repeat checkout attempt id from a different buyer refused", { orderNo: order.orderNo });
    return refusal("invalid_input");
  }

  let mayPay = order.status === "awaiting_payment" && order.paymentStatus === "pending";
  if (mayPay && !input.customer) {
    const token = input.orderAccessToken;
    const [match] =
      token && isWellFormedOrderAccessToken(token)
        ? await db
            .select({ id: orderAccessTokens.id })
            .from(orderAccessTokens)
            .where(
              and(
                eq(orderAccessTokens.orderId, order.id),
                eq(orderAccessTokens.tokenHash, hashOrderAccessToken(token)),
                sql`${orderAccessTokens.expiresAt} > now()`,
              ),
            )
            .limit(1)
        : [];
    mayPay = match !== undefined;
  }
  // The latest attempt: a finish-page retry may have replaced attempt 1's page.
  const [payment] = mayPay
    ? await db
        .select({ redirectUrl: payments.redirectUrl })
        .from(payments)
        .where(eq(payments.orderId, order.id))
        .orderBy(desc(payments.attempt))
        .limit(1)
    : [];
  return {
    ok: true,
    orderId: order.id,
    orderNo: order.orderNo,
    redirectUrl: payment?.redirectUrl ?? null,
    accessToken: null,
    productSlugs: [],
    replayed: true,
  };
}

function quoteRefusal(reason: ShippingQuoteRefusal): PlaceOrderRefusal {
  switch (reason) {
    case "unknown_area":
      return "unknown_area";
    case "missing_weight":
      return "shipping_missing_weight";
    case "empty":
      return "cart_empty";
    case "no_service":
      return "shipping_no_service";
    // Plan §4.5.5: every provider failure is "Coba lagi".
    case "unavailable":
    case "bad_response":
    case "budget_exhausted":
      return "shipping_unavailable";
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled shipping quote refusal: ${String(unhandled)}`);
    }
  }
}

interface LockedLine {
  sku: string;
  qty: number;
  unitPrice: number;
  weightGrams: number | null;
  purchasable: boolean;
  productName: string;
  productSlug: string;
  colorName: string;
  size: string;
}

async function lockedCartLines(tx: Tx, cartId: string): Promise<LockedLine[]> {
  const rows = await tx
    .select({
      sku: cartItems.sku,
      qty: cartItems.qty,
      unitPrice: products.basePrice,
      weightGrams: products.shippingWeightGrams,
      productActive: products.isActive,
      published: products.isPublishedOnStorefront,
      variantActive: productVariants.isActive,
      productName: products.name,
      productSlug: products.slug,
      colorName: fabricColors.name,
      size: productVariants.size,
    })
    .from(cartItems)
    .innerJoin(productVariants, eq(productVariants.sku, cartItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.addedAt), asc(cartItems.sku));
  return mergeBySku(
    rows.map((row) => ({
      sku: row.sku,
      qty: row.qty,
      unitPrice: row.unitPrice,
      weightGrams: row.weightGrams,
      purchasable: row.productActive && row.published && row.variantActive,
      productName: row.productName,
      productSlug: row.productSlug,
      colorName: row.colorName,
      size: row.size,
    })),
  );
}

/** The session customer: consent the buyer just gave is stamped if it was missing (plan §4.3),
 * and the WhatsApp number becomes the account's phone only when the account has none and no other
 * customer holds it (a 23505 on the phone UNIQUE is caught in a savepoint, never a check-then-write
 * failure of the whole order). */
async function updateSessionCustomer(tx: Tx, customerId: string, contactPhone: string, promoOptIn: boolean): Promise<void> {
  await tx
    .update(customers)
    .set({ pdpConsentAt: sql`now()` })
    .where(and(eq(customers.id, customerId), isNull(customers.pdpConsentAt)));
  if (promoOptIn) {
    await tx
      .update(customers)
      .set({ promoConsentAt: sql`now()` })
      .where(and(eq(customers.id, customerId), isNull(customers.promoConsentAt)));
  }
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint
        .update(customers)
        .set({ phone: contactPhone })
        .where(and(eq(customers.id, customerId), isNull(customers.phone)));
    });
  } catch (error) {
    // Someone else's number: the order keeps it as its contact, the account stays without one.
    if (!isPostgresConstraintViolation(error, "23505", ["customers_phone_unique"])) throw error;
    console.info("[checkout] checkout phone already belongs to another customer; account phone left empty", { customerId });
  }
}

/** A session customer's address for the next checkout (owner, 2026-10-21: "saved address", plan
 * §4.3): the order's address becomes the customer's default address (saveDefaultCustomerAddress,
 * an atomic default switch). Never for a guest (the email is unverified, D9; the /account offer
 * asks after a login instead). Inside the order transaction, so a refused or rolled-back order
 * saves nothing; under a savepoint, so an address the table refuses (a CHECK) never fails the order. */
async function saveSessionCustomerAddress(tx: Tx, customerId: string, address: ShippingAddress): Promise<void> {
  try {
    await tx.transaction(async (savepoint) => {
      await saveDefaultCustomerAddress(savepoint, customerId, address);
    });
  } catch (error) {
    // Data the table refuses (a CHECK, a length, a vanished area: 22xxx and 23xxx) only costs the
    // prefill; anything else (the connection, a deadlock) still fails the order as before.
    const cause = (error instanceof Error && error.cause !== undefined ? error.cause : error) as { code?: unknown; constraint_name?: unknown } | null;
    const code = typeof cause?.code === "string" ? cause.code : "";
    if (!code.startsWith("22") && !code.startsWith("23")) throw error;
    console.warn("[checkout] the order's address was not saved to the account; the order goes on", { customerId, code, constraint: cause?.constraint_name ?? null });
  }
}

/** A guest: link to the customer with this email, or create one (plan §5 step 4, insert-first like
 * loadOrCreateCustomerForEmail, so two concurrent first orders for one email resolve to the same
 * row). The email is unverified here (D9), so the customer row gets nothing a stranger could have
 * typed in someone else's name beyond the email and a display name: no phone (customers.phone is
 * UNIQUE, so a stranger could tie up someone's number) and no PDP or promo consent (owner decision
 * 2026-10-21, security review). The order itself keeps the phone and the consent evidence
 * (contact_phone, terms_accepted_at, promo_opt_in); they move to the customer only once the email
 * is proven by a login (the /consent gate asks for PDP consent then). An existing customer is never
 * changed. */
async function linkOrCreateGuestCustomer(tx: Tx, params: { email: string; name: string }): Promise<string> {
  const [created] = await tx
    .insert(customers)
    .values({ email: params.email, name: params.name })
    .onConflictDoNothing({ target: customers.email })
    .returning({ id: customers.id });
  if (created) return created.id;
  const [existing] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.email, params.email)).limit(1);
  if (!existing) throw new Error("customers row for the checkout email vanished between insert conflict and select");
  return existing.id;
}

interface PlacedOrder {
  kind: "placed";
  orderId: string;
  orderNo: string;
  paymentId: string;
  providerOrderId: string;
  grossAmount: number;
  paymentLines: ReturnType<typeof buildPaymentLines>;
  accessToken: string;
  productSlugs: string[];
}

interface Context {
  input: PlaceOrderInput;
  deps: PlaceOrderDeps;
  value: ValidatedInput;
  cartId: string;
  quotedLines: QuoteLine[];
  quote: ShippingQuote;
}

async function placeInTransaction(tx: Tx, ctx: Context): Promise<PlacedOrder | { kind: "replay"; order: ExistingOrder }> {
  const { input, deps, value, quote } = ctx;

  // No external call happens in here, so every lock is held briefly; a wait longer than this (an
  // admin stock count holding a variant, say) refuses with "Coba lagi" instead of queueing every
  // order of the month behind the order-number lock.
  await tx.execute(sql`set local lock_timeout = '${sql.raw(String(ORDER_LOCK_TIMEOUT_SECONDS))}s'`);

  // Lock order step 1: the cart row. A concurrent cart write (or a second submit) waits here.
  const [cart] = await tx.select({ id: carts.id }).from(carts).where(eq(carts.id, ctx.cartId)).for("no key update");
  if (!cart) throw new PlaceOrderRefused("cart_changed");

  // A second submit of the same attempt that waited for the first one's commit.
  const prior = await findOrderByAttempt(tx, input.checkoutAttemptId);
  if (prior) return { kind: "replay", order: prior };

  const lines = await lockedCartLines(tx, ctx.cartId);
  if (lines.length === 0) throw new PlaceOrderRefused("cart_empty");
  if (!sameLines(lines, ctx.quotedLines)) throw new PlaceOrderRefused("cart_changed");
  if (lines.some((line) => !line.purchasable)) throw new PlaceOrderRefused("cart_unavailable");
  if (lines.some((line) => line.qty > CART_MAX_QTY_PER_LINE)) throw new PlaceOrderRefused("line_limit");
  if (lines.reduce((sum, line) => sum + line.qty, 0) > CART_MAX_PIECES) throw new PlaceOrderRefused("cart_limit");

  // The weight the locked rows give must be the one that was quoted (a product's weight could have
  // been edited in between).
  const weight = parcelWeightGrams(lines.map((line) => ({ sku: line.sku, qty: line.qty, weightGrams: line.weightGrams })));
  if (!weight.ok) throw new PlaceOrderRefused(weight.reason === "missing_weight" ? "shipping_missing_weight" : "cart_empty");
  if (weight.grams !== quote.weightGrams) throw new PlaceOrderRefused("cart_changed");

  // At most 3 unpaid checkout orders in 2 hours (plan §5 step 1, against hoarding). A guest is
  // counted by contact email; a session customer by their own logged-in orders, so guest orders
  // someone else placed with their (unverified) email can never lock them out of checkout. The
  // advisory lock serializes concurrent checkouts for the same key, so the count cannot be raced.
  const capKey = input.customer ? `customer:${input.customer.id}` : `email:${value.contactEmail}`;
  await tx.execute(sql`select pg_advisory_xact_lock(${CONTACT_EMAIL_LOCK_NAMESPACE}::int, hashtext(${capKey}))`);
  const [unpaid] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        input.customer ? and(eq(orders.customerId, input.customer.id), eq(orders.placedWithSession, true)) : eq(orders.contactEmail, value.contactEmail),
        eq(orders.paymentStatus, "pending"),
        eq(orders.status, "awaiting_payment"),
        sql`${orders.createdAt} > now() - make_interval(mins => ${UNPAID_ORDER_WINDOW_MINUTES}::int)`,
      ),
    );
  if ((unpaid?.count ?? 0) >= MAX_UNPAID_ORDERS_PER_EMAIL) throw new PlaceOrderRefused("too_many_unpaid");

  let customerId: string;
  if (input.customer) {
    customerId = input.customer.id;
    await updateSessionCustomer(tx, customerId, value.contactPhone, input.promoOptIn);
  } else {
    customerId = await linkOrCreateGuestCustomer(tx, { email: value.contactEmail, name: value.address.recipientName });
  }

  const orderNo = await generateOrderNumber(tx);
  const subtotalAmount = lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  const shippingAmount = quote.buyerAmount;
  const runtime = deps.payment;

  // Inserted without the discount first: the voucher's used_order_id must point at an existing
  // order (FK), so the conditional voucher UPDATE runs after this and the totals follow it.
  const [order] = await tx
    .insert(orders)
    .values({
      channelId: "web",
      orderNo,
      status: "awaiting_payment",
      customerId,
      orderDate: sql`now()`,
      subtotalAmount,
      shippingAmount,
      discountAmount: 0,
      totalAmount: subtotalAmount + shippingAmount,
      shippingAddress: formatShippingAddress(value.address),
      paymentStatus: "pending",
      paymentExpiresAt: sql`now() + make_interval(mins => ${runtime.paymentExpiryMinutes}::int)`,
      contactEmail: value.contactEmail,
      contactPhone: value.contactPhone,
      recipientName: value.address.recipientName,
      shippingAddressSnapshot: toShippingAddressSnapshot(value.address),
      shippingAreaId: value.address.shippingAreaId,
      checkoutAttemptId: input.checkoutAttemptId,
      termsAcceptedAt: sql`now()`,
      promoOptIn: input.promoOptIn,
      placedWithSession: input.customer !== null,
      // The locked quote (plan §4.5.4): all eight together, never changed afterwards.
      shippingCostAmount: quote.costAmount,
      shippingSubsidyAmount: quote.subsidyAmount,
      shippingCourierCode: quote.courierCode,
      shippingServiceCode: quote.serviceCode,
      shippingCourierLabel: quote.label,
      shippingWeightGrams: quote.weightGrams,
      shippingDestinationId: quote.destinationId,
      shippingQuotedAt: quote.quotedAt,
    })
    .returning({ id: orders.id, paymentExpiresAt: orders.paymentExpiresAt });
  if (!order) throw new Error("failed to insert checkout order");

  // unit_cost stays 0 until payment: transitionOrderStatus's awaiting_payment -> to_ship writes
  // the sale movements and locks the moving-average cost then (the payment state machine,
  // payments/apply-status.ts).
  const items = await tx
    .insert(orderItems)
    .values(lines.map((line) => ({ orderId: order.id, sku: line.sku, qty: line.qty, unitPrice: line.unitPrice, unitCost: 0 })))
    .returning({ id: orderItems.id, sku: orderItems.sku, qty: orderItems.qty });

  try {
    await reserveStockForOrder(
      tx,
      order.id,
      items.map((item) => ({ orderItemId: item.id, sku: item.sku, qty: item.qty })),
      runtime.stockHoldMinutes,
    );
  } catch (error) {
    if (error instanceof FieldError) throw new PlaceOrderRefused("insufficient_stock", [{ field: error.field, message: error.message }], error.message);
    throw error;
  }

  // Voucher (session only, plan §5 step 8): one conditional UPDATE; zero rows refuses.
  let discountAmount = 0;
  if (input.voucherId !== null) {
    if (!input.customer || !UUID_PATTERN.test(input.voucherId)) throw new PlaceOrderRefused("voucher_unusable");
    const [voucher] = await tx
      .update(vouchers)
      .set({ status: "used", usedOrderId: order.id, usedAt: sql`now()` })
      .where(
        and(
          eq(vouchers.id, input.voucherId),
          eq(vouchers.customerId, input.customer.id),
          eq(vouchers.status, "active"),
          sql`${vouchers.expiresAt} > now()`,
        ),
      )
      .returning({ amount: vouchers.amount });
    if (!voucher) throw new PlaceOrderRefused("voucher_unusable");
    // Goods only: the voucher never reduces ongkir (plan §4.5.6).
    discountAmount = Math.min(voucher.amount, subtotalAmount);
  }

  const totalAmount = subtotalAmount + shippingAmount - discountAmount;
  if (totalAmount !== input.expectedTotal) throw new PlaceOrderRefused("total_changed");
  // A gateway cannot charge Rp0 (payments_gross_amount_check); only a voucher covering every
  // piece of a free-shipping order gets here.
  if (totalAmount <= 0) throw new PlaceOrderRefused("voucher_unusable");
  if (discountAmount > 0) {
    await tx.update(orders).set({ discountAmount, totalAmount }).where(eq(orders.id, order.id));
  }

  const paymentLines = buildPaymentLines({
    products: lines.map((line) => ({
      sku: line.sku,
      name: `${line.productName} ${line.colorName} ${sizeLabel(line.size)}`,
      unitPrice: line.unitPrice,
      qty: line.qty,
    })),
    shippingAmount,
    discountAmount,
    grossAmount: totalAmount,
  });
  const paymentOrderId = providerOrderId(runtime.orderIdPrefix, orderNo, 1);
  const [payment] = await tx
    .insert(payments)
    .values({
      orderId: order.id,
      // The fake stands in for Midtrans (the only provider the column allows).
      provider: "midtrans",
      providerOrderId: paymentOrderId,
      attempt: 1,
      grossAmount: totalAmount,
      status: "created",
      expiresAt: order.paymentExpiresAt,
    })
    .returning({ id: payments.id });
  if (!payment) throw new Error("failed to insert payment attempt");

  // The checkout cookie's view-only access to this one order (plan §4.4, §9.2).
  const accessToken = generateOrderAccessToken();
  await tx.insert(orderAccessTokens).values({
    orderId: order.id,
    tokenHash: hashOrderAccessToken(accessToken),
    expiresAt: sql`now() + make_interval(days => ${ORDER_ACCESS_TOKEN_DAYS}::int)`,
  });

  await tx.delete(cartItems).where(eq(cartItems.cartId, ctx.cartId));
  await tx.update(carts).set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(carts.id, ctx.cartId));

  // Logged-in buyers get this address prefilled next time (never a guest, D9). Last, so the row lock
  // it takes is held as briefly as possible.
  if (input.customer) await saveSessionCustomerAddress(tx, input.customer.id, value.address);

  // No contact or address in the audit row (plan §11 anonymizes those on the order itself).
  await writeAuditLog(tx, {
    actorStaffUserId: null,
    action: "web_checkout",
    entityType: "order",
    entityId: order.id,
    after: {
      orderNo,
      customerId,
      placedWithSession: input.customer !== null,
      subtotalAmount,
      shippingAmount,
      discountAmount,
      totalAmount,
      voucherId: input.voucherId,
      items: lines.map((line) => ({ sku: line.sku, qty: line.qty, unitPrice: line.unitPrice })),
      shipping: {
        courierCode: quote.courierCode,
        serviceCode: quote.serviceCode,
        costAmount: quote.costAmount,
        subsidyAmount: quote.subsidyAmount,
        weightGrams: quote.weightGrams,
        quotedAt: quote.quotedAt,
      },
      paymentOrderId,
    },
  });

  return {
    kind: "placed",
    orderId: order.id,
    orderNo,
    paymentId: payment.id,
    providerOrderId: paymentOrderId,
    grossAmount: totalAmount,
    paymentLines,
    accessToken,
    productSlugs: [...new Set(lines.map((line) => line.productSlug))],
  };
}

/** What is safe to log about a database (or other unexpected) error: its name and the Postgres
 * code and constraint, never the message (drizzle's "Failed query" text carries the parameters:
 * the buyer's email, phone and address). */
export function databaseErrorLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: typeof error };
  const cause = (error.cause ?? error) as { code?: unknown; constraint_name?: unknown };
  return { error: error.name, code: cause.code, constraint: cause.constraint_name };
}

/** Places a checkout order from the buyer's cart (plan §5). Expected refusals are returned, each
 * with its Indonesian message; database and other unexpected errors throw, for the caller to log
 * (with databaseErrorLogFields) and answer with a generic retry message. */
export async function placeOrder(db: Database, deps: PlaceOrderDeps, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const state = { clearGuestCookie: false };
  const outcome = await placeOrderSteps(db, deps, input, state);
  return { ...outcome, clearGuestCookie: state.clearGuestCookie };
}

async function placeOrderSteps(db: Database, deps: PlaceOrderDeps, input: PlaceOrderInput, state: { clearGuestCookie: boolean }): Promise<PlaceOrderOutcome> {
  if (typeof input.checkoutAttemptId !== "string" || !UUID_PATTERN.test(input.checkoutAttemptId)) return refusal("invalid_input");
  if (!Number.isSafeInteger(input.expectedTotal) || input.expectedTotal < 0) return refusal("invalid_input");

  const validated = await validate(db, input);
  if (!validated.ok) return refusal("invalid_input", validated.errors);
  const value = validated.value;

  const known = await findOrderByAttempt(db, input.checkoutAttemptId);
  if (known) return replay(db, known, input, value.contactEmail);
  if (deps.admit && !(await deps.admit())) return refusal("rate_limited");

  // A submit that lost a race to its own twin finds the cart already ordered: answer with the
  // twin's order instead of "cart empty".
  const orRefuse = async (reason: PlaceOrderRefusal, fieldErrors: PlaceOrderFieldError[] = [], message?: string): Promise<PlaceOrderOutcome> => {
    if (reason === "cart_empty" || reason === "cart_changed") {
      const twin = await findOrderByAttempt(db, input.checkoutAttemptId);
      if (twin) return replay(db, twin, input, value.contactEmail);
    }
    return refusal(reason, fieldErrors, message);
  };

  const identity: CartIdentity = { customerId: input.customer?.id ?? null, guestTokenHash: input.guestTokenHash };
  const resolution = await resolveCart(db, identity);
  state.clearGuestCookie = resolution.clearGuestCookie;
  const cartId = resolution.cartId;
  if (!cartId) return orRefuse("cart_empty");
  const quotedLines = await readCartLines(db, cartId);
  if (quotedLines.length === 0) return orRefuse("cart_empty");

  // Outside the transaction: this may call the shipping provider (plan §4.5.4).
  const quoted = await quoteShipping(db, deps.shipping, { areaId: value.address.shippingAreaId, lines: quotedLines });
  if (!quoted.ok) {
    const reason = quoteRefusal(quoted.reason);
    const fieldErrors = reason === "unknown_area" ? [{ field: "shippingAreaId", message: PLACE_ORDER_MESSAGES.unknown_area }] : [];
    return refusal(reason, fieldErrors, undefined, quoted.missingSkus);
  }
  // The area row was re-synced between validation and the quote: re-check instead of locking a
  // destination the snapshot does not name.
  if (quoted.quote.destinationId !== value.address.providerAreaId) return refusal("total_changed");

  let outcome: Awaited<ReturnType<typeof placeInTransaction>>;
  try {
    outcome = await db.transaction((tx) => placeInTransaction(tx, { input, deps, value, cartId, quotedLines, quote: quoted.quote }));
  } catch (error) {
    if (error instanceof PlaceOrderRefused) {
      if (error.reason !== "insufficient_stock" && error.reason !== "cart_changed") {
        console.warn(`[checkout] order refused: ${error.reason}`);
      }
      return orRefuse(error.reason, error.fieldErrors, error.message);
    }
    if (isPostgresErrorCode(error, "55P03")) {
      console.warn("[checkout] order refused: a lock wait passed lock_timeout");
      return refusal("busy");
    }
    // Two submits of one attempt that did not serialize on the cart lock (say, two carts after a
    // login in between): the UNIQUE decides, and the loser answers with the winner's order.
    if (isPostgresErrorCode(error, "23505")) {
      const winner = await findOrderByAttempt(db, input.checkoutAttemptId);
      if (winner) return replay(db, winner, input, value.contactEmail);
    }
    throw error;
  }
  if (outcome.kind === "replay") return replay(db, outcome.order, input, value.contactEmail);

  const redirectUrl = await requestPaymentPage(db, deps.payment, {
    paymentId: outcome.paymentId,
    orderNo: outcome.orderNo,
    providerOrderId: outcome.providerOrderId,
    grossAmount: outcome.grossAmount,
    lines: outcome.paymentLines,
    customer: { name: value.address.recipientName, email: value.contactEmail, phone: value.contactPhone },
    expiryMinutes: deps.payment.paymentExpiryMinutes,
    finishUrl: deps.finishUrl(outcome.orderNo),
  });
  return {
    ok: true,
    orderId: outcome.orderId,
    orderNo: outcome.orderNo,
    redirectUrl,
    accessToken: outcome.accessToken,
    productSlugs: outcome.productSlugs,
    replayed: false,
  };
}

import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder } from "@ammari/db/test-fixtures";
import { customers } from "@ammari/db/schema";
import { CONTACT_OFFER_CHANGED, CONTACT_OFFER_GONE, CONTACT_OFFER_PHONE_TAKEN, answerContactOffer, loadContactOffer, type ContactOffer } from "./contact-offer";

/** "Simpan" on the offer as shown. */
const save = (offer: ContactOffer | null, promo: boolean) => ({ kind: "save" as const, promo, seen: { orderNo: offer?.orderNo ?? "", phone: offer?.phone ?? null } });

// docs/plans/cart-checkout.md §9.3 (owner decision 2026-10-21, session 14): after a login, /account
// offers the WhatsApp number and promo choice a guest order recorded; nothing is copied unasked.

function phone(): string {
  return `+628${Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join("")}`;
}

async function guestCustomer(tx: TestTx) {
  return insertCustomer(tx, { phone: null, promoConsentAt: null, name: "Tamu", emailVerifiedAt: new Date() });
}

/** A checkout order of the customer, typed with the account's own email unless `contactEmail` says
 * otherwise. */
async function guestOrder(tx: TestTx, customerId: string, values: { contactPhone?: string | null; promoOptIn?: boolean; placedWithSession?: boolean; createdAt?: Date; contactEmail?: string } = {}) {
  const [account] = await tx.select({ email: customers.email }).from(customers).where(eq(customers.id, customerId));
  return insertOrder(tx, {
    ...checkoutOrderValues(),
    orderNo: `ORD-2097${Math.floor(Math.random() * 90 + 10)}-${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`,
    customerId,
    contactEmail: values.contactEmail ?? account?.email ?? "tamu@example.test",
    contactPhone: values.contactPhone === undefined ? phone() : values.contactPhone,
    promoOptIn: values.promoOptIn ?? false,
    placedWithSession: values.placedWithSession ?? false,
    subtotalAmount: 259_000,
    shippingAmount: 0,
    shippingCostAmount: 12_000,
    shippingSubsidyAmount: 12_000,
    discountAmount: 0,
    totalAmount: 259_000,
    ...(values.createdAt ? { createdAt: values.createdAt } : {}),
  });
}

describe("loadContactOffer", () => {
  test("offers the newest guest order's number and promo choice", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      await guestOrder(tx, customer.id, { createdAt: new Date(Date.now() - 60_000) });
      const newest = await guestOrder(tx, customer.id, { promoOptIn: true });
      expect(await loadContactOffer(customer.id, tx)).toEqual({ orderNo: newest.orderNo, orderDate: newest.orderDate, phone: newest.contactPhone, promo: true });
    });
  });

  test("never from a guest order typed with an email the account does not have (session 15 visibility rule)", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      await guestOrder(tx, customer.id, { promoOptIn: true, contactEmail: "someone-else@example.test" });
      expect(await loadContactOffer(customer.id, tx)).toBeNull();
    });
  });

  test("nothing from orders placed while logged in, manual orders, or before the last answer", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      await guestOrder(tx, customer.id, { placedWithSession: true, promoOptIn: true });
      await insertOrder(tx, { customerId: customer.id });
      expect(await loadContactOffer(customer.id, tx)).toBeNull();

      await guestOrder(tx, customer.id, { createdAt: new Date(Date.now() - 60_000) });
      await tx.update(customers).set({ contactOfferResolvedAt: sql`now()` }).where(eq(customers.id, customer.id));
      expect(await loadContactOffer(customer.id, tx)).toBeNull();
    });
  });

  test("never a number another account uses, and nothing the account already has", async () => {
    await withRollback(async (tx) => {
      const other = await insertCustomer(tx);
      const customer = await guestCustomer(tx);
      await guestOrder(tx, customer.id, { contactPhone: other.phone });
      expect(await loadContactOffer(customer.id, tx)).toBeNull();

      const full = await insertCustomer(tx, { promoConsentAt: new Date() });
      await guestOrder(tx, full.id, { promoOptIn: true });
      expect(await loadContactOffer(full.id, tx)).toBeNull();
    });
  });
});

describe("answerContactOffer", () => {
  test("Simpan copies the number, and promo consent only when ticked again; the offer is gone after", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      const order = await guestOrder(tx, customer.id, { promoOptIn: true });
      expect(await answerContactOffer(customer.id, save(await loadContactOffer(customer.id, tx), false), tx)).toEqual({ ok: true });
      const [saved] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(saved?.phone).toBe(order.contactPhone);
      expect(saved?.promoConsentAt).toBeNull();
      expect(saved?.contactOfferResolvedAt).not.toBeNull();
      expect(await loadContactOffer(customer.id, tx)).toBeNull();

      // A later guest order with promo ticked is offered again (promo only: the number is set).
      await guestOrder(tx, customer.id, { promoOptIn: true, createdAt: new Date(Date.now() + 1_000) });
      expect(await loadContactOffer(customer.id, tx)).toMatchObject({ phone: null, promo: true });
      await answerContactOffer(customer.id, save(await loadContactOffer(customer.id, tx), true), tx);
      const [again] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(again?.promoConsentAt).not.toBeNull();
      expect(again?.phone).toBe(order.contactPhone);
    });
  });

  test("Lewati writes nothing but the answer", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      await guestOrder(tx, customer.id, { promoOptIn: true });
      await answerContactOffer(customer.id, { kind: "skip" }, tx);
      const [row] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(row).toMatchObject({ phone: null, promoConsentAt: null });
      expect(row?.contactOfferResolvedAt).not.toBeNull();
    });
  });

  test("a number another account takes between the offer and the write: nothing written, a clear message", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      const order = await guestOrder(tx, customer.id, { promoOptIn: true });
      // The other account claims the number right before the UPDATE runs (after the re-read).
      const racing = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== "update") return Reflect.get(target, prop, receiver);
          return (table: typeof customers) => ({
            set: (values: Record<string, unknown>) => ({
              where: async (condition: Parameters<ReturnType<ReturnType<TestTx["update"]>["set"]>["where"]>[0]) => {
                await target.execute(sql`savepoint race`);
                await insertCustomer(target, { phone: order.contactPhone });
                try {
                  return await target.update(table).set(values).where(condition);
                } catch (error) {
                  await target.execute(sql`rollback to savepoint race`);
                  throw error;
                }
              },
            }),
          });
        },
      }) as TestTx;
      expect(await answerContactOffer(customer.id, save(await loadContactOffer(customer.id, tx), true), racing)).toEqual({ ok: false, message: CONTACT_OFFER_PHONE_TAKEN });
      const [row] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(row).toMatchObject({ phone: null, promoConsentAt: null, contactOfferResolvedAt: null });
    });
  });

  test("Simpan never saves an offer other than the one shown, and says when the offer is gone", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      await guestOrder(tx, customer.id, { createdAt: new Date(Date.now() - 60_000) });
      const shown = await loadContactOffer(customer.id, tx);
      // A stranger's guest order typed with this email arrives after the card was rendered.
      await guestOrder(tx, customer.id, { promoOptIn: true });
      expect(await answerContactOffer(customer.id, save(shown, true), tx)).toEqual({ ok: false, message: CONTACT_OFFER_CHANGED });
      const [row] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(row).toMatchObject({ phone: null, promoConsentAt: null, contactOfferResolvedAt: null });

      await answerContactOffer(customer.id, { kind: "skip" }, tx);
      expect(await answerContactOffer(customer.id, save(shown, true), tx)).toEqual({ ok: false, message: CONTACT_OFFER_GONE });
    });
  });
});

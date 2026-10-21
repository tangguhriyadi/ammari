import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder } from "@ammari/db/test-fixtures";
import { customerAddresses, customers, shippingAreas } from "@ammari/db/schema";
import { loadSavedCheckoutAddress } from "@/lib/checkout/queries";
import { CONTACT_OFFER_CHANGED, CONTACT_OFFER_GONE, CONTACT_OFFER_PHONE_TAKEN, answerContactOffer, contactOfferAddressKind, loadContactOffer, type ContactOffer } from "./contact-offer";

/** "Simpan" on the offer as shown. */
const save = (offer: ContactOffer | null, promo: boolean, useName = false, useAddress = false) => ({
  kind: "save" as const,
  promo,
  useName,
  useAddress,
  seen: { orderNo: offer?.orderNo ?? "", phone: offer?.phone ?? null, name: offer?.name ?? null, address: contactOfferAddressKind(offer) },
});

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
async function guestOrder(tx: TestTx, customerId: string, values: { contactPhone?: string | null; promoOptIn?: boolean; placedWithSession?: boolean; createdAt?: Date; contactEmail?: string; recipientName?: string; shipping?: { areaId: string; snapshot: unknown } } = {}) {
  const [account] = await tx.select({ email: customers.email }).from(customers).where(eq(customers.id, customerId));
  return insertOrder(tx, {
    ...checkoutOrderValues(),
    orderNo: `ORD-2097${Math.floor(Math.random() * 90 + 10)}-${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`,
    customerId,
    contactEmail: values.contactEmail ?? account?.email ?? "tamu@example.test",
    contactPhone: values.contactPhone === undefined ? phone() : values.contactPhone,
    promoOptIn: values.promoOptIn ?? false,
    recipientName: values.recipientName ?? "Rina Wati",
    placedWithSession: values.placedWithSession ?? false,
    subtotalAmount: 259_000,
    shippingAmount: 0,
    shippingCostAmount: 12_000,
    shippingSubsidyAmount: 12_000,
    discountAmount: 0,
    totalAmount: 259_000,
    ...(values.createdAt ? { createdAt: values.createdAt } : {}),
    ...(values.shipping ? { shippingAreaId: values.shipping.areaId, shippingAddressSnapshot: values.shipping.snapshot } : {}),
  });
}

describe("loadContactOffer", () => {
  test("offers the newest guest order's number and promo choice", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      await guestOrder(tx, customer.id, { createdAt: new Date(Date.now() - 60_000) });
      const newest = await guestOrder(tx, customer.id, { promoOptIn: true });
      expect(await loadContactOffer(customer.id, tx)).toEqual({ orderNo: newest.orderNo, orderDate: newest.orderDate, phone: newest.contactPhone, promo: true, name: null, address: null });
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

describe("the recipient name in the offer (2026-10-21 sandbox run)", () => {
  test("offered only while the account has the placeholder name, even when number and promo are settled", async () => {
    await withRollback(async (tx) => {
      const named = await guestCustomer(tx);
      await guestOrder(tx, named.id, { recipientName: "Siti Aminah" });
      expect((await loadContactOffer(named.id, tx))?.name).toBeNull();

      const placeholder = await insertCustomer(tx, { name: "Pelanggan Ammari", promoConsentAt: new Date(), emailVerifiedAt: new Date() });
      const order = await guestOrder(tx, placeholder.id, { recipientName: "  Siti   Aminah " });
      expect(await loadContactOffer(placeholder.id, tx)).toEqual({ orderNo: order.orderNo, orderDate: order.orderDate, phone: null, promo: false, name: "Siti Aminah", address: null });
    });
  });

  test("saved only when ticked, and never over a name the buyer set meanwhile", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx, { name: "Pelanggan Ammari", phone: null, promoConsentAt: null, emailVerifiedAt: new Date() });
      await guestOrder(tx, customer.id, { recipientName: "Siti Aminah" });
      expect(await answerContactOffer(customer.id, save(await loadContactOffer(customer.id, tx), false, false), tx)).toEqual({ ok: true });
      const [unticked] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, customer.id));
      expect(unticked?.name).toBe("Pelanggan Ammari");

      await guestOrder(tx, customer.id, { recipientName: "Siti Aminah", createdAt: new Date(Date.now() + 1_000) });
      expect(await answerContactOffer(customer.id, save(await loadContactOffer(customer.id, tx), false, true), tx)).toEqual({ ok: true });
      const [ticked] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, customer.id));
      expect(ticked?.name).toBe("Siti Aminah");

      // Another tab renamed the account after this card was rendered: the change is refused as "changed".
      await tx.update(customers).set({ name: "Pelanggan Ammari" }).where(eq(customers.id, customer.id));
      await guestOrder(tx, customer.id, { recipientName: "Rina Wati", createdAt: new Date(Date.now() + 2_000) });
      const shown = await loadContactOffer(customer.id, tx);
      await tx.update(customers).set({ name: "Nama Sendiri" }).where(eq(customers.id, customer.id));
      expect(await answerContactOffer(customer.id, save(shown, false, true), tx)).toEqual({ ok: false, message: CONTACT_OFFER_GONE });
      const [kept] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, customer.id));
      expect(kept?.name).toBe("Nama Sendiri");
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

// 2026-10-22 dev feedback: a guest order never saves an address, so after a login the next checkout
// started empty. The offer now also carries the order's address, saved as the default when ticked.
describe("the shipping address in the offer", () => {
  async function area(tx: TestTx, overrides: Partial<typeof shippingAreas.$inferInsert> = {}) {
    const [row] = await tx
      .insert(shippingAreas)
      .values({ province: "Jawa Barat", city: "Kota Bandung", district: "Coblong", postalCode: "40132", searchText: "coblong", label: "Coblong, Kota Bandung, Jawa Barat 40132", providerAreaId: `TEST${randomUUID()}`, ...overrides })
      .returning();
    return row!;
  }

  /** The snapshot placeOrder writes (version 2), for `areaId`. */
  function snapshot(areaId: string, overrides: Record<string, unknown> = {}) {
    return {
      version: 2,
      recipientName: "Siti Aminah",
      phone: "+6281234567890",
      addressLine: "Jl. Melati No. 5, RT 02/RW 03",
      notes: "Pagar hijau",
      shippingAreaId: areaId,
      providerAreaId: "IGNORED",
      province: "Jawa Barat",
      city: "Kota Bandung",
      district: "Coblong",
      subdistrict: null,
      postalCode: "40132",
      ...overrides,
    };
  }

  async function savedAddresses(tx: TestTx, customerId: string) {
    return tx
      .select({ recipientName: customerAddresses.recipientName, addressLine: customerAddresses.addressLine, shippingAreaId: customerAddresses.shippingAreaId, notes: customerAddresses.notes, postalCode: customerAddresses.postalCode, isDefault: customerAddresses.isDefault })
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
  }

  async function insertSaved(tx: TestTx, customerId: string, areaId: string, addressLine = "Jl. Lama 1") {
    await tx.insert(customerAddresses).values({
      customerId,
      recipientName: "Siti Aminah",
      phone: "+6281234567890",
      addressLine,
      shippingAreaId: areaId,
      province: "Jawa Barat",
      city: "Kota Bandung",
      district: "Coblong",
      postalCode: "40132",
      notes: null,
      isDefault: true,
    });
  }

  test("offered read-only from the order, against the area as it is now; Simpan with it ticked makes it the default address the checkout reads", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      const dago = await area(tx);
      const order = await guestOrder(tx, customer.id, { shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      const offer = await loadContactOffer(customer.id, tx);
      expect(offer).toMatchObject({
        orderNo: order.orderNo,
        address: { recipientName: "Siti Aminah", phone: "+6281234567890", addressLine: "Jl. Melati No. 5, RT 02/RW 03", notes: "Pagar hijau", areaLabel: "Coblong, Kota Bandung, Jawa Barat 40132", replacesSaved: false, seenKey: "new" },
      });
      // Only what the card shows: no area or provider ids reach the browser.
      expect(Object.keys(offer!.address!).sort()).toEqual(["addressLine", "areaLabel", "notes", "phone", "recipientName", "replacesSaved", "seenKey"]);

      expect(await answerContactOffer(customer.id, save(offer, false, false, true), tx)).toEqual({ ok: true });
      expect(await savedAddresses(tx, customer.id)).toEqual([
        { recipientName: "Siti Aminah", addressLine: "Jl. Melati No. 5, RT 02/RW 03", shippingAreaId: dago.id, notes: "Pagar hijau", postalCode: "40132", isDefault: true },
      ]);
      expect(await loadSavedCheckoutAddress(customer.id, tx)).toMatchObject({ addressLine: "Jl. Melati No. 5, RT 02/RW 03", area: { id: dago.id } });
      expect(await loadContactOffer(customer.id, tx)).toBeNull();
    });
  });

  test("Simpan with the address box unticked saves the rest but no address; Lewati saves nothing", async () => {
    await withRollback(async (tx) => {
      const unticked = await guestCustomer(tx);
      const dago = await area(tx);
      const order = await guestOrder(tx, unticked.id, { shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      expect(await answerContactOffer(unticked.id, save(await loadContactOffer(unticked.id, tx), false, false, false), tx)).toEqual({ ok: true });
      expect(await savedAddresses(tx, unticked.id)).toEqual([]);
      const [account] = await tx.select({ phone: customers.phone }).from(customers).where(eq(customers.id, unticked.id));
      expect(account?.phone).toBe(order.contactPhone);

      const skipped = await guestCustomer(tx);
      await guestOrder(tx, skipped.id, { shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      expect(await answerContactOffer(skipped.id, { kind: "skip" }, tx)).toEqual({ ok: true });
      expect(await savedAddresses(tx, skipped.id)).toEqual([]);
      expect(await loadContactOffer(skipped.id, tx)).toBeNull();
    });
  });

  test("skipped when the area no longer resolves (no provider id), or the snapshot is not one checkout writes", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      const stale = await area(tx, { providerAreaId: null });
      await guestOrder(tx, customer.id, { shipping: { areaId: stale.id, snapshot: snapshot(stale.id) } });
      expect((await loadContactOffer(customer.id, tx))?.address).toBeNull();

      const other = await guestCustomer(tx);
      const dago = await area(tx);
      await guestOrder(tx, other.id, { contactPhone: null, shipping: { areaId: dago.id, snapshot: snapshot(dago.id, { version: 1 }) } });
      expect(await loadContactOffer(other.id, tx)).toBeNull();
    });
  });

  test("never from a guest order typed with an email the account does not have", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      const dago = await area(tx);
      await guestOrder(tx, customer.id, { contactEmail: "someone-else@example.test", shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      expect(await loadContactOffer(customer.id, tx)).toBeNull();
      expect(await answerContactOffer(customer.id, { kind: "save", promo: false, useName: false, useAddress: true, seen: { orderNo: "", phone: null, name: null, address: "new" } }, tx)).toEqual({ ok: false, message: CONTACT_OFFER_GONE });
      expect(await savedAddresses(tx, customer.id)).toEqual([]);
    });
  });

  test("with a saved address: a different one is offered unticked as a replacement, the same one not at all", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx, { phone: null, promoConsentAt: new Date(), name: "Siti", emailVerifiedAt: new Date() });
      const dago = await area(tx);
      await insertSaved(tx, customer.id, dago.id);
      await guestOrder(tx, customer.id, { contactPhone: null, shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      const offer = await loadContactOffer(customer.id, tx);
      expect(offer?.address?.replacesSaved).toBe(true);
      expect(offer?.address?.seenKey).toMatch(/^replace:[0-9a-f]{16}$/);
      expect(await answerContactOffer(customer.id, save(offer, false, false, true), tx)).toEqual({ ok: true });
      expect((await savedAddresses(tx, customer.id)).map((row) => row.addressLine)).toEqual(["Jl. Melati No. 5, RT 02/RW 03"]);

      // A later guest order to the address now saved: nothing left to offer.
      await guestOrder(tx, customer.id, { contactPhone: null, createdAt: new Date(Date.now() + 1_000), shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      expect(await loadContactOffer(customer.id, tx)).toBeNull();
    });
  });

  test("an address saved in another tab after the card was shown: refused as changed, nothing written", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      const dago = await area(tx);
      await guestOrder(tx, customer.id, { shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      const shown = await loadContactOffer(customer.id, tx);
      expect(shown?.address?.replacesSaved).toBe(false);
      await insertSaved(tx, customer.id, dago.id, "Jl. Dari Tab Lain 9");
      expect(await answerContactOffer(customer.id, save(shown, false, false, true), tx)).toEqual({ ok: false, message: CONTACT_OFFER_CHANGED });
      expect((await savedAddresses(tx, customer.id)).map((row) => row.addressLine)).toEqual(["Jl. Dari Tab Lain 9"]);
      const [row] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(row).toMatchObject({ phone: null, contactOfferResolvedAt: null });
    });
  });

  test("a default that appears between the re-read and the write rolls the whole answer back", async () => {
    await withRollback(async (tx) => {
      const customer = await guestCustomer(tx);
      const dago = await area(tx);
      await guestOrder(tx, customer.id, { shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      const shown = await loadContactOffer(customer.id, tx);
      // Another checkout saves a default right as the answer's transaction starts.
      const racing = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== "transaction") return Reflect.get(target, prop, receiver);
          return async (run: Parameters<TestTx["transaction"]>[0]) => {
            await insertSaved(target, customer.id, dago.id, "Jl. Balapan 3");
            return target.transaction(run);
          };
        },
      }) as TestTx;
      expect(await answerContactOffer(customer.id, save(shown, false, false, true), racing)).toEqual({ ok: false, message: CONTACT_OFFER_CHANGED });
      expect((await savedAddresses(tx, customer.id)).map((row) => row.addressLine)).toEqual(["Jl. Balapan 3"]);
      const [row] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(row).toMatchObject({ phone: null, contactOfferResolvedAt: null });
    });
  });

  test("a replacement over a saved address changed in another tab after the card was shown: refused, the newer one kept", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx, { phone: null, promoConsentAt: new Date(), name: "Siti", emailVerifiedAt: new Date() });
      const dago = await area(tx);
      await insertSaved(tx, customer.id, dago.id);
      await guestOrder(tx, customer.id, { contactPhone: null, shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      const shown = await loadContactOffer(customer.id, tx);
      expect(shown?.address?.replacesSaved).toBe(true);
      // A checkout in another tab saves a newer default in place.
      await tx.update(customerAddresses).set({ addressLine: "Jl. Tab Lain 7" }).where(eq(customerAddresses.customerId, customer.id));
      expect(await answerContactOffer(customer.id, save(shown, false, false, true), tx)).toEqual({ ok: false, message: CONTACT_OFFER_CHANGED });
      expect((await savedAddresses(tx, customer.id)).map((row) => row.addressLine)).toEqual(["Jl. Tab Lain 7"]);
      const [row] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(row?.contactOfferResolvedAt).toBeNull();
    });
  });

  test("a replacement whose saved address changes between the re-read and the write: the conflict's WHERE keeps it", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx, { phone: null, promoConsentAt: new Date(), name: "Siti", emailVerifiedAt: new Date() });
      const dago = await area(tx);
      await insertSaved(tx, customer.id, dago.id);
      await guestOrder(tx, customer.id, { contactPhone: null, shipping: { areaId: dago.id, snapshot: snapshot(dago.id) } });
      const shown = await loadContactOffer(customer.id, tx);
      const racing = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== "transaction") return Reflect.get(target, prop, receiver);
          return async (run: Parameters<TestTx["transaction"]>[0]) => {
            await target.update(customerAddresses).set({ addressLine: "Jl. Balapan 4" }).where(eq(customerAddresses.customerId, customer.id));
            return target.transaction(run);
          };
        },
      }) as TestTx;
      expect(await answerContactOffer(customer.id, save(shown, false, false, true), racing)).toEqual({ ok: false, message: CONTACT_OFFER_CHANGED });
      expect((await savedAddresses(tx, customer.id)).map((row) => row.addressLine)).toEqual(["Jl. Balapan 4"]);
    });
  });
});

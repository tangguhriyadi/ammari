import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import { customerAuthAccounts, customerAuthUsers, payments, voucherAdjustments, vouchers } from "@ammari/db/schema";
import { getPeriodTotals } from "@/lib/overview/queries";
import { getCustomerDetail, listCustomers } from "./directory";
import type { CustomerListParams } from "./search-params";

// docs/plans/growth.md §8 (session S4). Each test searches by its own marker, so other rows in the
// test database never match.

const DAY = 86_400_000;

function params(overrides: Partial<CustomerListParams>): CustomerListParams {
  return { sort: "newest", includeNonBuyers: false, ...overrides };
}

async function withAccount(db: TestDatabase, customer: { id: string; name: string; email: string | null }, providers: string[]) {
  const [user] = await db.insert(customerAuthUsers).values({ customerId: customer.id, name: customer.name, email: customer.email ?? `${randomUUID()}@example.test`, emailVerified: true }).returning();
  for (const providerId of providers) await db.insert(customerAuthAccounts).values({ userId: user!.id, accountId: randomUUID(), providerId });
}

async function voucherFor(db: TestDatabase, customerId: string, overrides: Partial<typeof vouchers.$inferInsert> = {}) {
  const order = await insertOrder(db, { customerId });
  const card = await insertThankYouCard(db, order.id, { status: "claimed", claimedByCustomerId: customerId, claimedAt: new Date() });
  const [row] = await db.insert(vouchers).values({ cardId: card.id, customerId, expiresAt: new Date(Date.now() + 30 * DAY), ...overrides }).returning();
  return { voucher: row!, cardOrder: order, card };
}

describe("listCustomers", () => {
  test("contacts leave the server masked only; origin and consent come along", async () => {
    await withRollback(async (tx) => {
      const marker = `Mask-${randomUUID().slice(0, 8)}`;
      const customer = await insertCustomer(tx, { name: `${marker} Sari`, email: `nurul-${marker}@gmail.com`, phone: "+6281234564567", promoConsentAt: new Date() });
      await withAccount(tx, customer, ["google"]);
      const { rows } = await listCustomers(params({ q: marker }), undefined, undefined, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: customer.id, maskedEmail: "nu***@gmail.com", maskedPhone: "+62 812 **** 4567", origin: "account", orderCount: 0, totalSpend: 0 });
      expect(rows[0]!.promoConsentAt).toBeInstanceOf(Date);
      // No full contact anywhere in the row.
      expect(JSON.stringify(rows[0])).not.toContain(customer.email);
      expect(JSON.stringify(rows[0])).not.toContain("+6281234564567");
    });
  });

  test("a customer with no counted order and no account is hidden unless asked for (A13)", async () => {
    await withRollback(async (tx) => {
      const marker = `Hidden-${randomUUID().slice(0, 8)}`;
      const unpaidGuest = await insertCustomer(tx, { name: `${marker} Tamu`, phone: null, pdpConsentAt: null });
      await insertOrder(tx, { ...checkoutOrderValues(), customerId: unpaidGuest.id });
      const staffMade = await insertCustomer(tx, { name: `${marker} Staf`, email: null, pdpConsentAt: null });
      const buyer = await insertCustomer(tx, { name: `${marker} Pembeli`, email: null });
      await insertOrder(tx, { customerId: buyer.id, channelId: "whatsapp", channelOrderNo: null, status: "completed" });

      const shown = await listCustomers(params({ q: marker }), undefined, undefined, tx);
      expect(shown.rows.map((row) => row.id)).toEqual([buyer.id]);
      expect(shown.rows[0]?.origin).toBe("staff");
      const all = await listCustomers(params({ q: marker, includeNonBuyers: true }), undefined, undefined, tx);
      expect(new Map(all.rows.map((row) => [row.id, row.origin]))).toEqual(
        new Map([
          [unpaidGuest.id, "guest"],
          [staffMade.id, "staff"],
          [buyer.id, "staff"],
        ]),
      );
    });
  });

  test("filters: account, buyer, promo, active voucher (effective, not the stored status)", async () => {
    await withRollback(async (tx) => {
      const marker = `Filter-${randomUUID().slice(0, 8)}`;
      const account = await insertCustomer(tx, { name: `${marker} A` });
      await withAccount(tx, account, []);
      const promo = await insertCustomer(tx, { name: `${marker} P`, promoConsentAt: new Date() });
      await withAccount(tx, promo, ["google"]);
      const withVoucher = await insertCustomer(tx, { name: `${marker} V` });
      await voucherFor(tx, withVoucher.id);
      const lapsed = await insertCustomer(tx, { name: `${marker} L` });
      await voucherFor(tx, lapsed.id, { issuedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - DAY) });

      const ids = async (filter: CustomerListParams["filter"]) => (await listCustomers(params({ q: marker, filter, includeNonBuyers: true }), undefined, undefined, tx)).rows.map((row) => row.id).sort();
      expect(await ids("account")).toEqual([account.id, promo.id].sort());
      // The voucher fixtures' card orders are counted orders of their own customers.
      expect(await ids("buyer")).toEqual([withVoucher.id, lapsed.id].sort());
      expect(await ids("promo")).toEqual([promo.id]);
      expect(await ids("voucher")).toEqual([withVoucher.id]);
    });
  });

  test("search matches name, full email, and a phone typed as 08...", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      const digits = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
      const customer = await insertCustomer(tx, { name: `Ibu Search ${marker}`, email: `search-${marker}@example.test`, phone: `+62857${digits}` });
      await withAccount(tx, customer, []);
      for (const q of [`search ${marker}`, `search-${marker}@example`, `0857${digits.slice(0, 4)}`, `+62 857 ${digits}`]) {
        const { rows } = await listCustomers(params({ q }), undefined, undefined, tx);
        expect(rows.map((row) => row.id), q).toContain(customer.id);
      }
      expect((await listCustomers(params({ q: `0858${digits}` }), undefined, undefined, tx)).rows.map((row) => row.id)).not.toContain(customer.id);
    });
  });

  test("orders, last order and total belanja use the Ringkasan counted-order definition", async () => {
    await withRollback(async (tx) => {
      const marker = `Agg-${randomUUID().slice(0, 8)}`;
      const customer = await insertCustomer(tx, { name: marker });
      // A month nobody else's fixtures use, so getPeriodTotals sees only these orders.
      const day = (d: number) => new Date(Date.UTC(2003, 4, d, 3));
      await insertOrder(tx, { customerId: customer.id, status: "completed", orderDate: day(2), subtotalAmount: 300_000, discountAmount: 20_000 });
      await insertOrder(tx, { customerId: customer.id, status: "shipped", orderDate: day(9), subtotalAmount: 150_000 });
      await insertOrder(tx, { customerId: customer.id, status: "cancelled", orderDate: day(10), subtotalAmount: 999_000 });
      await insertOrder(tx, { customerId: customer.id, status: "returned", orderDate: day(11), subtotalAmount: 888_000 });
      const refunded = await insertOrder(tx, { ...checkoutOrderValues(), customerId: customer.id, status: "to_ship", paymentStatus: "partially_refunded", paidAt: day(12), orderDate: day(12), subtotalAmount: 200_000, shippingAmount: 0, totalAmount: 200_000 });
      await tx.insert(payments).values({ orderId: refunded.id, provider: "midtrans", providerOrderId: `T-${randomUUID()}`, attempt: 1, grossAmount: 200_000, status: "paid", paidAt: day(12), refundedAmount: 50_000, expiresAt: day(13) });
      await insertOrder(tx, { ...checkoutOrderValues(), customerId: customer.id, status: "to_ship", paymentStatus: "refunded", paidAt: day(13), orderDate: day(13), subtotalAmount: 777_000, shippingAmount: 0, totalAmount: 777_000 });

      const { rows } = await listCustomers(params({ q: marker }), undefined, undefined, tx);
      const totals = await getPeriodTotals({ start: day(1), end: day(31) }, { canViewProfit: true }, tx);
      expect(rows[0]).toMatchObject({ orderCount: 3, totalSpend: 280_000 + 150_000 + 150_000 });
      expect(rows[0]?.totalSpend).toBe(totals.money?.omzet);
      expect(rows[0]?.orderCount).toBe(totals.orders);
      expect(rows[0]?.lastOrderAt).toEqual(day(12));
    });
  });

  test("sorts by total belanja and by last order", async () => {
    await withRollback(async (tx) => {
      const marker = `Sort-${randomUUID().slice(0, 8)}`;
      const small = await insertCustomer(tx, { name: `${marker} kecil` });
      await insertOrder(tx, { customerId: small.id, status: "completed", subtotalAmount: 100_000, orderDate: new Date(Date.now() - DAY) });
      const big = await insertCustomer(tx, { name: `${marker} besar` });
      await insertOrder(tx, { customerId: big.id, status: "completed", subtotalAmount: 900_000, orderDate: new Date(Date.now() - 5 * DAY) });
      const bySpend = await listCustomers(params({ q: marker, sort: "spend" }), undefined, undefined, tx);
      expect(bySpend.rows.map((row) => row.id)).toEqual([big.id, small.id]);
      const byLast = await listCustomers(params({ q: marker, sort: "last_order" }), undefined, undefined, tx);
      expect(byLast.rows.map((row) => row.id)).toEqual([small.id, big.id]);
    });
  });
});

describe("getCustomerDetail", () => {
  test("full contacts, sign-in methods, orders without contact snapshots, effective vouchers with history, claimed cards", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx, { name: "Ibu Detail", promoConsentAt: new Date(), emailVerifiedAt: new Date() });
      await withAccount(tx, customer, ["google", "credential"]);
      const counted = await insertOrder(tx, { customerId: customer.id, status: "completed", contactEmail: "rahasia@example.test", shippingAddress: "Jl. Rahasia 1" });
      const cancelled = await insertOrder(tx, { customerId: customer.id, status: "cancelled" });
      const active = await voucherFor(tx, customer.id);
      const lapsed = await voucherFor(tx, customer.id, { issuedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - DAY) });
      const staff = await insertStaffUser(tx);
      await tx.insert(voucherAdjustments).values({ voucherId: lapsed.voucher.id, kind: "extend", previousStatus: "active", previousExpiresAt: lapsed.voucher.expiresAt, newExpiresAt: new Date(lapsed.voucher.expiresAt.getTime() + DAY), reason: "Sakit", staffUserId: staff.id });

      const detail = await getCustomerDetail(customer.id, tx);
      expect(detail).toMatchObject({ id: customer.id, email: customer.email, phone: customer.phone, account: { methods: ["email_code", "google"] } });
      // Counted: the completed order and both voucher card orders (to_ship by default).
      expect(detail?.orderCount).toBe(3);
      expect(detail?.orders.map((order) => order.id)).toEqual(expect.arrayContaining([counted.id, cancelled.id]));
      expect(detail?.orders.find((order) => order.id === cancelled.id)?.counted).toBe(false);
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain("rahasia@example.test");
      expect(serialized).not.toContain("Jl. Rahasia");
      expect(Object.keys(detail!.orders[0]!).sort()).toEqual(["channelName", "counted", "id", "orderDate", "orderNo", "paymentStatus", "status", "totalAmount"]);

      const byId = new Map(detail!.vouchers.map((voucher) => [voucher.id, voucher]));
      expect(byId.get(active.voucher.id)).toMatchObject({ status: "active", amount: 20_000, cardOrderNo: active.cardOrder.orderNo, adjustments: [] });
      expect(byId.get(lapsed.voucher.id)).toMatchObject({ status: "expired", adjustments: [{ kind: "extend", reason: "Sakit", staffName: staff.name }] });
      expect(detail?.claimedCards.map((card) => card.orderNo).sort()).toEqual([active.cardOrder.orderNo, lapsed.cardOrder.orderNo].sort());
    });
  });

  test("an unknown or malformed id is null; a staff-made customer has no account", async () => {
    await withRollback(async (tx) => {
      expect(await getCustomerDetail("bukan-id", tx)).toBeNull();
      expect(await getCustomerDetail(randomUUID(), tx)).toBeNull();
      const staffMade = await insertCustomer(tx, { email: null, pdpConsentAt: null });
      expect(await getCustomerDetail(staffMade.id, tx)).toMatchObject({ account: null, orders: [], vouchers: [], claimedCards: [], orderCount: 0, totalSpend: 0 });
    });
  });
});

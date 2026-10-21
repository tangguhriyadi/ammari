import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, insertStaffUser, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { customers, orderAccessTokens, orderItems, orderNotifications, orders, payments, stockMovements, stockReservations, storeSettings } from "@ammari/db/schema";
import type { Tx } from "../db";
import { hashOrderAccessToken } from "../checkout/access-token";
import { formatRupiah } from "./format";
import { transitionOrderStatus } from "../orders/lifecycle";
import { applyPaymentStatus } from "../payments/apply-status";
import { createFakePaymentProvider } from "../payments/fake";
import { PaymentProviderError, type PaymentProvider, type PaymentStatusReport } from "../payments/provider";
import { parsePaymentStatusBody } from "../payments/status";
import { sweepExpiredPayments } from "../payments/sweep";
import { adjustStock } from "../stock/ledger";
import { reserveStockForOrder } from "../stock/reservations";
import { dispatchOrderEmails, dispatchPendingOrderEmails, dueOrderEmails, type LoginLinkIssueOutcome, type OrderEmailDeps, type OrderEmailState } from "./dispatch";
import { renderCancelledEmail, renderCreatedEmail, renderOwnerPaidEmail, renderPaidEmail, renderShippedEmail, type CustomerOrderEmailView } from "./templates";
import { deriveOrderEmailAccessToken, deriveOrderEmailLoginToken } from "./token";

// docs/plans/cart-checkout.md D14, §8 (session 13): order emails. The transport is a recorder
// (nothing reaches Resend); the link secret is built at runtime.

const SECRET = ["test", "order", "email", "link", "secret", "x".repeat(16)].join("-");
const PRICE = 259_000;

type Sent = { to: string; subject: string; body: string; html?: string; idempotencyKey?: string };

function recorder(fail: (sent: Sent) => Error | null = () => null) {
  const sent: Sent[] = [];
  const attempts: Sent[] = [];
  const transport = {
    async send(message: Sent) {
      attempts.push(message);
      const error = fail(message);
      if (error) throw error;
      sent.push(message);
    },
  };
  const deps: OrderEmailDeps = { transport, siteOrigin: "https://ammari.example", adminOrigin: "https://admin.ammari.example", linkSecret: SECRET };
  return { deps, sent, attempts };
}

function deliveryError(): Error {
  const error = new Error("email send failed (500, internal_server_error)");
  error.name = "EmailDeliveryError";
  return error;
}

const forOrder = (sent: Sent[], orderNo: string) => sent.filter((message) => message.subject.includes(orderNo));

// ---------- dueOrderEmails ----------

function state(overrides: Partial<OrderEmailState>): OrderEmailState {
  return { status: "awaiting_payment", paymentStatus: "pending", paymentExpiresAt: new Date(Date.now() + 60_000), paidAt: null, cancelledAt: null, cancelReason: null, needsAttention: [], ...overrides };
}

describe("dueOrderEmails", () => {
  const now = new Date();
  test("a pending order inside its window needs `created`; after the window nothing", () => {
    expect(dueOrderEmails(state({}), now)).toEqual([{ kind: "created" }]);
    expect(dueOrderEmails(state({ paymentExpiresAt: new Date(now.getTime() - 1) }), now)).toEqual([]);
  });
  test("paid and in Diproses: customer `paid` (confirmed) and `owner_paid`", () => {
    expect(dueOrderEmails(state({ status: "to_ship", paymentStatus: "paid", paidAt: now }), now)).toEqual([
      { kind: "paid", variant: "confirmed" },
      { kind: "owner_paid", variant: "paid" },
    ]);
  });
  test("paid with stock short: the short `paid` note and the owner's stock-short alert", () => {
    expect(dueOrderEmails(state({ paymentStatus: "paid", paidAt: now, needsAttention: ["stock_short_at_payment"] }), now)).toEqual([
      { kind: "paid", variant: "review" },
      { kind: "owner_paid", variant: "stock_short" },
    ]);
  });
  test("paid after cancel: the short note and the owner's refund alert, never `cancelled`", () => {
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "paid", paidAt: now, cancelReason: "payment_expired", needsAttention: ["paid_after_cancel", "refund_due"] }), now)).toEqual([
      { kind: "paid", variant: "review" },
      { kind: "owner_paid", variant: "after_cancel" },
    ]);
  });
  test("expired, gateway-cancelled or cancelled by staff (unpaid or paid): `cancelled`", () => {
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" }), now)).toEqual([{ kind: "cancelled", reason: "payment_expired" }]);
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "cancelled", cancelReason: "payment_cancelled" }), now)).toEqual([{ kind: "cancelled", reason: "payment_cancelled" }]);
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "cancelled", cancelReason: "admin" }), now)).toEqual([{ kind: "cancelled", reason: "admin_unpaid" }]);
    const earlier = new Date(now.getTime() - 60_000);
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "paid", paidAt: earlier, cancelledAt: now, cancelReason: "admin" }), now)).toEqual([{ kind: "cancelled", reason: "admin_paid" }]);
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "refunded", paidAt: earlier, cancelledAt: now, cancelReason: "admin" }), now)).toEqual([{ kind: "cancelled", reason: "admin_paid" }]);
    // Paid after the staff cancel and refunded since (flags cleared): still the unpaid cancel email,
    // never a late "dana akan dikembalikan".
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "refunded", paidAt: now, cancelledAt: earlier, cancelReason: "admin" }), now)).toEqual([{ kind: "cancelled", reason: "admin_unpaid" }]);
    // Paid after a staff cancel: the review note, not a second cancel email.
    expect(dueOrderEmails(state({ status: "cancelled", paymentStatus: "paid", paidAt: now, cancelReason: "admin", needsAttention: ["paid_after_cancel", "refund_due"] }), now)).toEqual([
      { kind: "paid", variant: "review" },
      { kind: "owner_paid", variant: "after_cancel" },
    ]);
  });
  test("shipped: `shipped`; completed and returned: nothing; manual and marketplace orders: never", () => {
    expect(dueOrderEmails(state({ status: "shipped", paymentStatus: "paid", paidAt: now }), now)).toEqual([{ kind: "shipped" }]);
    expect(dueOrderEmails(state({ status: "completed", paymentStatus: "paid", paidAt: now }), now)).toEqual([]);
    expect(dueOrderEmails(state({ status: "returned", paymentStatus: "paid", paidAt: now }), now)).toEqual([]);
    expect(dueOrderEmails(state({ status: "shipped", paymentStatus: null }), now)).toEqual([]);
    expect(dueOrderEmails(state({ status: "to_ship", paymentStatus: null, paidAt: null }), now)).toEqual([]);
  });
});

// ---------- templates ----------

const baseView: CustomerOrderEmailView = {
  orderNo: "ORD-202612-0007",
  greetingName: "Siti <Aminah>",
  lines: [
    { productName: "Haura Dress", colorName: "Beige", sizeLabel: "M", qty: 2, lineTotal: 518_000 },
    { productName: "Khimar Syar'i", colorName: "Hitam", sizeLabel: "All Size", qty: 1, lineTotal: 129_000 },
  ],
  totals: { subtotal: 647_000, shipping: 75_000, shippingCost: 95_000, shippingSubsidy: 20_000, discount: 20_000, total: 702_000 },
  courierLabel: "JNE Reguler",
  address: { recipientName: "Siti Aminah", phone: "+6281234567890", addressText: "Jl. Melati No. 5 RT 01/02, Kelurahan Contoh, Kecamatan E2E, Kota Contoh, Provinsi Contoh 40111" },
  orderUrl: "https://ammari.example/orders/ORD-202612-0007?t=abc",
  loginUrl: null,
  siteHost: "ammari.example",
  whatsappNumber: "6288808541442",
};
const deadline = new Date("2026-12-01T07:30:00Z");

const allRendered = () => [
  renderCreatedEmail({ ...baseView, paymentDeadline: deadline, paymentUrl: "https://pay.example/page/x" }),
  renderCreatedEmail({ ...baseView, paymentDeadline: deadline, paymentUrl: null }),
  renderPaidEmail(baseView, "confirmed"),
  renderPaidEmail(baseView, "review"),
  renderCancelledEmail({ ...baseView, reason: "payment_expired", paymentDeadline: deadline }),
  renderCancelledEmail({ ...baseView, reason: "payment_cancelled", paymentDeadline: deadline }),
  renderCancelledEmail({ ...baseView, reason: "admin_unpaid", paymentDeadline: deadline }),
  renderCancelledEmail({ ...baseView, reason: "admin_paid", paymentDeadline: deadline }),
  renderShippedEmail({ ...baseView, courier: "JNE", trackingNumber: "JNE123456789" }),
  renderShippedEmail({ ...baseView, courier: null, trackingNumber: null }),
  ...(["paid", "stock_short", "after_cancel"] as const).map((variant) =>
    renderOwnerPaidEmail({
      orderNo: baseView.orderNo,
      variant,
      lines: baseView.lines,
      totals: baseView.totals,
      courierLabel: "JNE Reguler",
      paidAt: deadline,
      buyer: { name: "Siti", email: "siti@example.test", phone: "+6281234567890" },
      address: baseView.address,
      adminOrderUrl: "https://admin.ammari.example/orders/x",
    }),
  ),
];

describe("templates", () => {
  test("no em or en dash, no gateway or shipping provider name, in any subject, text or html", () => {
    for (const email of allRendered()) {
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/[—–]/);
        expect(part).not.toMatch(/midtrans|biteship|komerce|snap/i);
      }
    }
  });

  test("money as Rp with dots, the deadline in WIB, the ongkir subsidy line, voucher and total", () => {
    const email = renderCreatedEmail({ ...baseView, paymentDeadline: deadline, paymentUrl: "https://pay.example/x" });
    expect(email.subject).toBe("Pesanan ORD-202612-0007 menunggu pembayaran");
    expect(email.text).toContain("1 Desember 2026, 14.30 WIB");
    expect(email.text).toContain("Haura Dress\nBeige, M x 2: Rp518.000");
    expect(email.text).toContain("Ongkir: Rp75.000\n(Ongkir Rp95.000, subsidi Ammari -Rp20.000.)");
    expect(email.text).toContain("Voucher: -Rp20.000");
    expect(email.text).toContain("Total: Rp702.000");
    expect(email.text).toContain("Lanjutkan pembayaran:\nhttps://pay.example/x");
    expect(email.text).toContain("Lihat pesanan:\nhttps://ammari.example/orders/ORD-202612-0007?t=abc");
    expect(email.html).toContain("Ongkir Rp95.000, subsidi Ammari -Rp20.000.");
  });

  test("a fully subsidized ongkir says so; no subsidy line without a quote", () => {
    const covered = renderPaidEmail({ ...baseView, totals: { ...baseView.totals, shipping: 0, shippingCost: 18_000, shippingSubsidy: 18_000 } }, "confirmed");
    expect(covered.text).toContain("Ongkir: Rp0\n(Ongkir Rp18.000, ditanggung penuh subsidi Ammari.)");
    const none = renderPaidEmail({ ...baseView, totals: { ...baseView.totals, shippingCost: null, shippingSubsidy: null } }, "confirmed");
    expect(none.text).not.toContain("subsidi");
  });

  test("HTML escapes every value and has the mobile viewport; the text part has no markup", () => {
    const email = renderPaidEmail(baseView, "confirmed");
    expect(email.html).toContain("Halo Siti &lt;Aminah&gt;,");
    expect(email.html).toContain("Khimar Syar&#39;i");
    expect(email.html).not.toContain("<Aminah>");
    expect(email.html).toContain('name="viewport"');
    expect(email.text).toContain("Halo Siti <Aminah>,");
    expect(email.text).not.toMatch(/<(table|tr|td|a |p>|div|br)/i);
  });

  test("customer emails never carry the buyer's courier note; the owner email carries contact and address", () => {
    const owner = allRendered().at(-3)!;
    expect(owner.subject).toBe("Pesanan baru dibayar: ORD-202612-0007");
    expect(owner.text).toContain("siti@example.test");
    expect(owner.text).toContain("+6281234567890");
    expect(owner.text).toContain("Buka di admin:\nhttps://admin.ammari.example/orders/x");
    expect(allRendered().at(-2)!.subject).toBe("Perlu dicek: ORD-202612-0007 dibayar, stok kurang");
    expect(allRendered().at(-1)!.subject).toBe("Perlu dicek: ORD-202612-0007 dibayar setelah dibatalkan");
  });

  test("the review note promises no shipping; the cancelled email notes the voucher came back", () => {
    const review = renderPaidEmail(baseView, "review");
    expect(review.text).toContain("menghubungi kamu lewat WhatsApp");
    expect(review.text).not.toContain("resi");
    const cancelled = renderCancelledEmail({ ...baseView, reason: "payment_expired", paymentDeadline: deadline });
    expect(cancelled.subject).toBe("Pesanan ORD-202612-0007 dibatalkan");
    expect(cancelled.text).toContain("Voucher yang kamu pakai sudah kembali");
    // "Pesan lagi" opens the order page, which has the refill button (session 15).
    expect(cancelled.text).toContain("Pesan lagi:\nhttps://ammari.example/orders/ORD-202612-0007?t=abc");
    expect(cancelled.html).toContain('href="https://ammari.example/orders/ORD-202612-0007?t=abc"');
    expect(cancelled.text).not.toContain("Belanja lagi");
    expect(renderCancelledEmail({ ...baseView, totals: { ...baseView.totals, discount: 0 }, reason: "payment_expired", paymentDeadline: deadline }).text).not.toContain("Voucher");
  });

  test("a staff cancel names no reason: unpaid says nothing was charged and offers Pesan lagi; paid promises the full refund by WhatsApp", () => {
    const unpaid = renderCancelledEmail({ ...baseView, reason: "admin_unpaid", paymentDeadline: deadline });
    expect(unpaid.subject).toBe("Pesanan ORD-202612-0007 dibatalkan");
    expect(unpaid.text).toContain("Pesanan ORD-202612-0007 kami batalkan. Tidak ada dana yang ditarik untuk pesanan ini.");
    expect(unpaid.text).not.toContain("batas waktu");
    expect(unpaid.text).toContain("Voucher yang kamu pakai sudah kembali");
    expect(unpaid.text).toContain("Pesan lagi:\nhttps://ammari.example/orders/ORD-202612-0007?t=abc");

    const paid = renderCancelledEmail({ ...baseView, reason: "admin_paid", paymentDeadline: deadline });
    expect(paid.subject).toBe("Pesanan ORD-202612-0007 dibatalkan");
    expect(paid.text).toContain(`Dana ${formatRupiah(baseView.totals.total)} (termasuk ongkir) akan kami kembalikan penuh.`);
    expect(paid.text).toContain("Tim kami akan menghubungi kamu lewat WhatsApp untuk proses pengembaliannya.");
    expect(paid.text).toContain("Voucher yang kamu pakai sudah kembali");
    expect(paid.text).not.toContain("Pesan lagi");
    expect(paid.text).not.toContain("Tidak ada dana yang ditarik");
    expect(paid.text).toContain("Lihat pesanan");
  });

  test("the shipped email shows courier and resi when known", () => {
    const shipped = renderShippedEmail({ ...baseView, courier: "JNE", trackingNumber: "JNE123456789" });
    expect(shipped.subject).toBe("Pesanan ORD-202612-0007 sudah dikirim");
    expect(shipped.text).toContain("Kurir: JNE\nNomor resi: JNE123456789");
  });
});

describe("deriveOrderEmailAccessToken", () => {
  test("deterministic per notification and secret, shaped like a random order access token", () => {
    const id = randomUUID();
    const token = deriveOrderEmailAccessToken(SECRET, id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveOrderEmailAccessToken(SECRET, id)).toBe(token);
    expect(deriveOrderEmailAccessToken(SECRET, randomUUID())).not.toBe(token);
    expect(deriveOrderEmailAccessToken(`${SECRET}-other`, id)).not.toBe(token);
  });
});

describe("deriveOrderEmailLoginToken", () => {
  test("deterministic per notification, unrelated to the view token of the same email", () => {
    const id = randomUUID();
    const token = deriveOrderEmailLoginToken(SECRET, id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveOrderEmailLoginToken(SECRET, id)).toBe(token);
    expect(token).not.toBe(deriveOrderEmailAccessToken(SECRET, id));
  });
});

// ---------- fixtures ----------

interface Placed {
  orderId: string;
  orderNo: string;
  providerOrderId: string;
  total: number;
  sku: string;
}

function orderNo(): string {
  return `ORD-2098${String(randomInt(10, 99))}-${String(randomInt(10_000_000, 99_999_999))}`;
}

/** A placed checkout order with one line, its stock held and one payment attempt. */
async function placedOrder(db: TestDatabase, options: { window?: "open" | "over"; stock?: number; voucher?: boolean } = {}): Promise<Placed> {
  const { variant } = await insertProductVariant(db);
  const stock = options.stock ?? 3;
  if (stock > 0) await db.insert(stockMovements).values({ sku: variant.sku, qty: stock, valueAmount: stock * 100_000, type: "production", refType: "manual" });
  const customer = await insertCustomer(db, { name: "Siti Aminah" });
  const quote = shippingQuoteValues(95_000);
  const discount = options.voucher ? 20_000 : 0;
  const total = PRICE + (quote.shippingAmount ?? 0) - discount;
  const no = orderNo();
  const windowEnd = options.window === "over" ? -(10 * 24 * 60 + 30) * 60_000 : 30 * 60_000;
  const order = await insertOrder(db, {
    ...checkoutOrderValues(),
    ...quote,
    orderNo: no,
    customerId: customer.id,
    subtotalAmount: PRICE,
    discountAmount: discount,
    totalAmount: total,
    contactEmail: customer.email,
    contactPhone: "+6281234567890",
    recipientName: "Siti Aminah",
    shippingAddress: "Siti Aminah, +6281299990000, Jl. Melati 5, Kecamatan E2E, Kota Contoh, Provinsi Contoh 40111",
    shippingAddressSnapshot: { version: 2, recipientName: "Siti Aminah", phone: "+6281299990000", addressLine: "Jl. Melati 5", notes: "Pagar hijau", district: "Kecamatan E2E", city: "Kota Contoh", province: "Provinsi Contoh", postalCode: "40111" },
    paymentExpiresAt: new Date(Date.now() + windowEnd),
  });
  const [item] = await db.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: PRICE, unitCost: 0 }).returning();
  if (!item) throw new Error("item fixture");
  await reserveStockForOrder(db as Tx, order.id, [{ orderItemId: item.id, sku: variant.sku, qty: 1 }], 75);
  await db.update(stockReservations).set({ expiresAt: new Date(Date.now() + windowEnd + 15 * 60_000) }).where(eq(stockReservations.orderId, order.id));
  const providerOrderId = `MAIL-${no}-1`;
  await db.insert(payments).values({
    orderId: order.id,
    provider: "midtrans",
    providerOrderId,
    attempt: 1,
    grossAmount: total,
    status: "pending",
    snapToken: "snap-1",
    redirectUrl: `https://pay.example/redirection/${no}`,
    expiresAt: order.paymentExpiresAt,
  });
  return { orderId: order.id, orderNo: no, providerOrderId, total, sku: variant.sku };
}

function report(placed: Placed, transactionStatus: string): PaymentStatusReport {
  const parsed = parsePaymentStatusBody({
    order_id: placed.providerOrderId,
    transaction_status: transactionStatus,
    status_code: transactionStatus === "settlement" ? "200" : "407",
    gross_amount: `${placed.total}.00`,
    currency: "IDR",
    payment_type: "bca_va",
    transaction_id: `trx-${placed.providerOrderId}`,
    fraud_status: "accept",
  });
  if (!parsed) throw new Error("status fixture did not parse");
  return parsed;
}

async function setSupportEmail(db: TestDatabase, email: string | null): Promise<void> {
  await db.insert(storeSettings).values({ id: 1, supportEmail: email }).onConflictDoUpdate({ target: storeSettings.id, set: { supportEmail: email } });
}

async function notificationRows(db: TestDatabase, orderId: string) {
  return db.select().from(orderNotifications).where(eq(orderNotifications.orderId, orderId)).orderBy(orderNotifications.kind);
}

/** Moves every notification row of the order back past the lease (the trigger would reset it). */
async function ageNotifications(db: TestDatabase, orderId: string, minutes: number): Promise<void> {
  const at = new Date(Date.now() - minutes * 60_000);
  await withTriggerDisabled(db, "order_notifications", "set_updated_at", () =>
    db.update(orderNotifications).set({ updatedAt: at, createdAt: at }).where(eq(orderNotifications.orderId, orderId)),
  );
}

function quiet() {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
}

// ---------- dispatch (rolled back) ----------

describe("dispatchOrderEmails", () => {
  test("created: one email with the payment link and a working view link; a duplicate call sends nothing", async () => {
    await withRollback(async (tx) => {
      const { deps, sent } = recorder();
      const placed = await placedOrder(tx);
      const first = await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect(first.results).toEqual([{ kind: "created", outcome: "sent" }]);
      const second = await dispatchOrderEmails(tx, deps, { orderId: placed.orderId });
      expect(second.results).toEqual([]);
      expect(forOrder(sent, placed.orderNo)).toHaveLength(1);

      const [email] = sent;
      expect(email!.subject).toBe(`Pesanan ${placed.orderNo} menunggu pembayaran`);
      expect(email!.body).toContain(`https://pay.example/redirection/${placed.orderNo}`);
      expect(email!.html).toContain("<!doctype html>");
      expect(email!.idempotencyKey).toMatch(/^order-email\/[0-9a-f-]{36}$/);
      // The view link's token is stored only as its sha256, valid 120 days.
      const token = new URL(email!.body.match(/https:\/\/ammari\.example\/orders\/\S+/)![0]).searchParams.get("t")!;
      const [stored] = await tx.select().from(orderAccessTokens).where(eq(orderAccessTokens.tokenHash, hashOrderAccessToken(token)));
      expect(stored).toMatchObject({ orderId: placed.orderId });
      expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBe(120 * 24 * 60 * 60 * 1000);
      expect(await notificationRows(tx, placed.orderId)).toMatchObject([{ kind: "created", error: null }]);
      expect((await notificationRows(tx, placed.orderId))[0]!.sentAt).not.toBeNull();
    });
  });

  test("paid (through the state machine): the buyer's confirmation and the owner alert, each once", async () => {
    await withRollback(async (tx) => {
      const { deps, sent } = recorder();
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx);
      await dispatchOrderEmails(tx, deps, { orderId: placed.orderId });
      expect((await applyPaymentStatus(tx, report(placed, "settlement")))?.outcome).toBe("paid");
      // A replayed notification and the finish page's check both call it again.
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      const mine = forOrder(sent, placed.orderNo);
      expect(mine.map((message) => [message.to.includes("pemilik") ? "owner" : "buyer", message.subject])).toEqual([
        ["buyer", `Pesanan ${placed.orderNo} menunggu pembayaran`],
        ["buyer", `Pembayaran pesanan ${placed.orderNo} sudah kami terima`],
        ["owner", `Pesanan baru dibayar: ${placed.orderNo}`],
      ]);
      const owner = mine[2]!;
      expect(owner.body).toContain(`https://admin.ammari.example/orders/${placed.orderId}`);
      expect(owner.body).toContain("Pagar hijau");
      expect(mine[1]!.body).not.toContain("Pagar hijau");
      expect(mine[1]!.body).toContain("Jl. Melati 5, Kecamatan E2E, Kota Contoh, Provinsi Contoh 40111");
    });
  });

  test("paid with stock short: the short note to the buyer and the stock-short alert to the owner", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps, sent } = recorder();
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx, { stock: 1 });
      // A marketplace sale takes the held piece (D4).
      const staff = await insertStaffUser(tx);
      await adjustStock({ sku: placed.sku, deltaQty: -1, reason: "damaged" }, staff.id, tx);
      expect((await applyPaymentStatus(tx, report(placed, "settlement")))?.outcome).toBe("paid_stock_short");
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect(forOrder(sent, placed.orderNo).map((message) => message.subject)).toEqual([
        `Pembayaran pesanan ${placed.orderNo} sudah kami terima`,
        `Perlu dicek: ${placed.orderNo} dibayar, stok kurang`,
      ]);
      expect(sent[0]!.body).toContain("menghubungi kamu lewat WhatsApp");
    });
  });

  test("expired, then paid after cancel: `cancelled` once, then the short note and the refund alert", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps, sent } = recorder();
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx, { voucher: false });
      expect((await applyPaymentStatus(tx, report(placed, "expire")))?.outcome).toBe("expired");
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect((await applyPaymentStatus(tx, report(placed, "settlement")))?.outcome).toBe("paid_after_cancel");
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect(forOrder(sent, placed.orderNo).map((message) => message.subject)).toEqual([
        `Pesanan ${placed.orderNo} dibatalkan`,
        `Pembayaran pesanan ${placed.orderNo} sudah kami terima`,
        `Perlu dicek: ${placed.orderNo} dibayar setelah dibatalkan`,
      ]);
    });
  });

  test("shipped by staff: courier and resi; found by the cron pass (no hook in admin)", async () => {
    await withRollback(async (tx) => {
      const { deps, sent } = recorder();
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx);
      await applyPaymentStatus(tx, report(placed, "settlement"));
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      const staff = await insertStaffUser(tx);
      await transitionOrderStatus(placed.orderId, "shipped", staff.id, tx, { courier: "JNE", trackingNumber: "JNE00012345" });
      await dispatchPendingOrderEmails(tx, deps);
      await dispatchPendingOrderEmails(tx, deps);
      const shipped = forOrder(sent, placed.orderNo).filter((message) => message.subject.includes("sudah dikirim"));
      expect(shipped).toHaveLength(1);
      expect(shipped[0]!.body).toContain("Nomor resi: JNE00012345");
    });
  });

  test("customer-typed text: a link-like name is left out of the greeting; line breaks never reach the text part", async () => {
    await withRollback(async (tx) => {
      const { deps, sent } = recorder();
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx);
      const [order] = await tx.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, placed.orderId));
      await tx.update(customers).set({ name: "Klik www.hadiah.example sekarang" }).where(eq(customers.id, order!.customerId!));
      await tx
        .update(orders)
        .set({ shippingAddressSnapshot: { version: 2, recipientName: "Siti\nPalsu: baris", phone: "+6281299990000", addressLine: "Jl. Melati 5\r\nKlik link", district: "Kecamatan E2E", city: "Kota Contoh", province: "Provinsi Contoh", postalCode: "40111" } })
        .where(eq(orders.id, placed.orderId));
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect(sent[0]!.body).toContain("Halo,\n");
      expect(sent[0]!.body).not.toContain("hadiah");
      await applyPaymentStatus(tx, report(placed, "settlement"));
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      const paid = forOrder(sent, placed.orderNo).find((message) => message.subject.startsWith("Pembayaran"))!;
      expect(paid.body).toContain("Penerima: Siti Palsu: baris");
      expect(paid.body).toContain("Alamat: Jl. Melati 5 Klik link, Kecamatan E2E");
    });
  });

  test("a manual web order (no payment_status) never gets an email", async () => {
    await withRollback(async (tx) => {
      const { deps, sent } = recorder();
      const order = await insertOrder(tx, { channelId: "web", channelOrderNo: null, status: "to_ship", contactEmail: "manual@example.test" });
      expect((await dispatchOrderEmails(tx, deps, { orderId: order.id })).results).toEqual([]);
      expect(sent.filter((message) => message.to === "manual@example.test")).toEqual([]);
      expect(await notificationRows(tx, order.id)).toEqual([]);
    });
  });

  test("owner email without store_settings.support_email: recorded as no recipient, sent once it is set", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps, sent } = recorder();
      await setSupportEmail(tx, null);
      const placed = await placedOrder(tx);
      await applyPaymentStatus(tx, report(placed, "settlement"));
      const first = await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect(first.results).toContainEqual({ kind: "owner_paid", outcome: "no_recipient" });
      expect((await notificationRows(tx, placed.orderId)).find((row) => row.kind === "owner_paid")).toMatchObject({ sentAt: null, error: "no_recipient" });
      await setSupportEmail(tx, "pemilik@example.test");
      await ageNotifications(tx, placed.orderId, 11);
      await dispatchPendingOrderEmails(tx, deps);
      expect(forOrder(sent, placed.orderNo).filter((message) => message.to === "pemilik@example.test")).toHaveLength(1);
    });
  });
});

/** An in-memory stand-in for @ammari/auth's issueOrReuseCustomerLoginLink (the real one is tested
 * in packages/auth and through apps/web's order email tests): same answers, no database. */
function fakeLoginLinks(options: { answer?: LoginLinkIssueOutcome; fail?: boolean } = {}) {
  const issued = new Set<string>();
  const calls: { token: string; customerId: string; email: string; orderId: string; mayIssue: boolean }[] = [];
  return {
    calls,
    loginLinks: {
      async issueOrReuse(input: (typeof calls)[number]): Promise<LoginLinkIssueOutcome> {
        calls.push(input);
        if (options.fail) throw new Error("database down");
        if (options.answer) return options.answer;
        if (issued.has(input.token)) return "existing";
        if (!input.mayIssue) return "not_issued";
        issued.add(input.token);
        return "issued";
      },
    },
  };
}

const loginLinkOf = (message: Sent) => message.body.match(/Masuk ke akun:\n(\S+)/)?.[1] ?? null;

describe("\"Masuk ke akun\" in guest order emails (session 14)", () => {
  test("created and paid emails of a guest order carry their own login link; shipped does not", async () => {
    await withRollback(async (tx) => {
      const { deps, sent } = recorder();
      const links = fakeLoginLinks();
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx);
      await dispatchOrderEmails(tx, { ...deps, loginLinks: links.loginLinks }, { orderNo: placed.orderNo });
      await applyPaymentStatus(tx, report(placed, "settlement"));
      await dispatchOrderEmails(tx, { ...deps, loginLinks: links.loginLinks }, { orderNo: placed.orderNo });
      await tx.update(orders).set({ status: "shipped", courier: "JNE", trackingNumber: "JNE1" }).where(eq(orders.id, placed.orderId));
      await dispatchOrderEmails(tx, { ...deps, loginLinks: links.loginLinks }, { orderNo: placed.orderNo });

      const rows = await notificationRows(tx, placed.orderId);
      const created = rows.find((row) => row.kind === "created")!;
      const paid = rows.find((row) => row.kind === "paid")!;
      const [order] = await tx.select().from(orders).where(eq(orders.id, placed.orderId));
      const buyer = forOrder(sent, placed.orderNo).filter((message) => !message.to.includes("pemilik"));
      expect(buyer.map((message) => message.subject)).toEqual([
        `Pesanan ${placed.orderNo} menunggu pembayaran`,
        `Pembayaran pesanan ${placed.orderNo} sudah kami terima`,
        `Pesanan ${placed.orderNo} sudah dikirim`,
      ]);
      expect(loginLinkOf(buyer[0]!)).toBe(`https://ammari.example/login/link?token=${deriveOrderEmailLoginToken(SECRET, created.id)}`);
      expect(loginLinkOf(buyer[1]!)).toBe(`https://ammari.example/login/link?token=${deriveOrderEmailLoginToken(SECRET, paid.id)}`);
      expect(loginLinkOf(buyer[2]!)).toBeNull();
      expect(buyer[0]!.html).toContain("Masuk ke akun");
      // The owner email never carries one.
      expect(forOrder(sent, placed.orderNo).filter((message) => message.to.includes("pemilik")).every((message) => loginLinkOf(message) === null)).toBe(true);
      // Bound to the order's customer and contact email; both issued on a first attempt.
      expect(links.calls.map((call) => ({ customerId: call.customerId, email: call.email, orderId: call.orderId, mayIssue: call.mayIssue }))).toEqual([
        { customerId: order!.customerId, email: order!.contactEmail, orderId: placed.orderId, mayIssue: true },
        { customerId: order!.customerId, email: order!.contactEmail, orderId: placed.orderId, mayIssue: true },
      ]);
    });
  });

  test("an order placed while logged in, or without the issuer, gets no login link", async () => {
    await withRollback(async (tx) => {
      const { deps, sent } = recorder();
      const links = fakeLoginLinks();
      const placed = await placedOrder(tx);
      await tx.update(orders).set({ placedWithSession: true }).where(eq(orders.id, placed.orderId));
      await dispatchOrderEmails(tx, { ...deps, loginLinks: links.loginLinks }, { orderNo: placed.orderNo });
      const other = await placedOrder(tx);
      await dispatchOrderEmails(tx, deps, { orderNo: other.orderNo });
      expect(links.calls).toHaveLength(0);
      expect(sent.map(loginLinkOf)).toEqual([null, null]);
    });
  });

  test("a retry renders the identical payload: it reuses the first attempt's link and never issues a new one", async () => {
    await withRollback(async (tx) => {
      quiet();
      let down = true;
      const { deps, attempts } = recorder(() => (down ? deliveryError() : null));
      const links = fakeLoginLinks();
      const withLinks = { ...deps, loginLinks: links.loginLinks };
      const placed = await placedOrder(tx);
      await dispatchOrderEmails(tx, withLinks, { orderNo: placed.orderNo });
      down = false;
      await ageNotifications(tx, placed.orderId, 11);
      await dispatchOrderEmails(tx, withLinks, { orderNo: placed.orderNo });

      const mine = forOrder(attempts, placed.orderNo);
      expect(mine).toHaveLength(2);
      expect(mine[1]).toEqual(mine[0]);
      expect(loginLinkOf(mine[0]!)).not.toBeNull();
      expect(links.calls.map((call) => call.mayIssue)).toEqual([true, false]);
    });
  });

  test("a first attempt that issued nothing (cap reached) stays without a link on retry", async () => {
    await withRollback(async (tx) => {
      quiet();
      let down = true;
      const { deps, attempts } = recorder(() => (down ? deliveryError() : null));
      const placed = await placedOrder(tx);
      await dispatchOrderEmails(tx, { ...deps, loginLinks: fakeLoginLinks({ answer: "limited" }).loginLinks }, { orderNo: placed.orderNo });
      down = false;
      await ageNotifications(tx, placed.orderId, 11);
      // The retry's issuer would issue if it were allowed to; it is not (mayIssue false).
      await dispatchOrderEmails(tx, { ...deps, loginLinks: fakeLoginLinks().loginLinks }, { orderNo: placed.orderNo });
      const mine = forOrder(attempts, placed.orderNo);
      expect(mine.map(loginLinkOf)).toEqual([null, null]);
      expect(mine[1]).toEqual(mine[0]);
    });
  });

  test("an issuer failure sends the email without the link instead of holding it back", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps, sent } = recorder();
      const placed = await placedOrder(tx);
      const result = await dispatchOrderEmails(tx, { ...deps, loginLinks: fakeLoginLinks({ fail: true }).loginLinks }, { orderNo: placed.orderNo });
      expect(result.results).toEqual([{ kind: "created", outcome: "sent" }]);
      expect(sent.map(loginLinkOf)).toEqual([null]);
      expect(console.error).toHaveBeenCalledWith("[emails] could not issue the login link; the email goes without it", expect.objectContaining({ orderNo: placed.orderNo }));
    });
  });
});

describe("a failed send (Resend down)", () => {
  test("never touches the order; recorded without the address; retried after the lease with the identical payload and key", async () => {
    await withRollback(async (tx) => {
      quiet();
      let down = true;
      const { deps, sent, attempts } = recorder(() => (down ? deliveryError() : null));
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx);
      await applyPaymentStatus(tx, report(placed, "settlement"));
      const before = (await tx.select().from(orders).where(eq(orders.id, placed.orderId)))[0]!;

      const result = await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect(result.results).toEqual([
        { kind: "paid", outcome: "failed" },
        { kind: "owner_paid", outcome: "failed" },
      ]);
      const after = (await tx.select().from(orders).where(eq(orders.id, placed.orderId)))[0]!;
      expect(after).toEqual(before);
      const rows = await notificationRows(tx, placed.orderId);
      expect(rows.map((row) => [row.kind, row.sentAt, row.error])).toEqual([
        ["owner_paid", null, "email send failed (500, internal_server_error)"],
        ["paid", null, "email send failed (500, internal_server_error)"],
      ]);

      // Inside the lease: not retried (a send may still be in progress elsewhere).
      down = false;
      await dispatchPendingOrderEmails(tx, deps);
      expect(forOrder(sent, placed.orderNo)).toHaveLength(0);

      // After the lease: retried once, same payload and same idempotency key.
      await ageNotifications(tx, placed.orderId, 11);
      const summary = await dispatchPendingOrderEmails(tx, deps);
      expect(summary.sent).toBeGreaterThanOrEqual(2);
      const mine = forOrder(attempts, placed.orderNo);
      expect(mine).toHaveLength(4);
      const buyerAttempts = mine.filter((message) => !message.to.includes("pemilik"));
      expect(buyerAttempts[1]).toEqual(buyerAttempts[0]);
      expect(forOrder(sent, placed.orderNo)).toHaveLength(2);
      expect((await notificationRows(tx, placed.orderId)).every((row) => row.sentAt !== null && row.error === null)).toBe(true);
    });
  });

  test("a transport that throws something unexpected is recorded by name only", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps } = recorder((message) => new TypeError(`boom for ${message.to}`));
      const placed = await placedOrder(tx);
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect((await notificationRows(tx, placed.orderId))[0]).toMatchObject({ error: "TypeError", sentAt: null });
    });
  });

  test("retries stop after 23 hours (inside the provider's 24-hour idempotency window) and are counted as abandoned", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps, sent } = recorder(() => deliveryError());
      const placed = await placedOrder(tx);
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      await ageNotifications(tx, placed.orderId, 23 * 60 + 1);
      const working = recorder();
      const summary = await dispatchPendingOrderEmails(tx, working.deps);
      expect(forOrder(working.sent, placed.orderNo)).toEqual([]);
      expect(forOrder(sent, placed.orderNo)).toEqual([]);
      expect(summary.abandoned).toBeGreaterThanOrEqual(1);
    });
  });

  test("a failed email that is no longer due (created, then paid) is marked superseded: not retried, not reported lost", async () => {
    await withRollback(async (tx) => {
      quiet();
      let down = true;
      const { deps, sent } = recorder(() => (down ? deliveryError() : null));
      await setSupportEmail(tx, "pemilik@example.test");
      const placed = await placedOrder(tx);
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      await applyPaymentStatus(tx, report(placed, "settlement"));
      down = false;
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      const rows = await notificationRows(tx, placed.orderId);
      expect(rows.find((row) => row.kind === "created")).toMatchObject({ sentAt: null, error: "superseded" });
      await ageNotifications(tx, placed.orderId, 23 * 60 + 5);
      const summary = await dispatchPendingOrderEmails(tx, deps);
      expect(forOrder(sent, placed.orderNo).map((message) => message.subject).filter((subject) => subject.includes("menunggu"))).toEqual([]);
      // Only the still-due kinds count; created is superseded and paid/owner were sent.
      expect(summary.abandoned).toBe(0);
    });
  });

  test.each([
    [422, "validation_error"],
    [409, "invalid_idempotent_request"],
  ])("a %i %s refusal is permanent: recorded, logged as an error, never retried", async (status, providerError) => {
    await withRollback(async (tx) => {
      quiet();
      const refusal = Object.assign(new Error(`email send failed (${status}, ${providerError})`), { name: "EmailDeliveryError", status, providerError });
      const { deps, attempts } = recorder(() => refusal);
      const placed = await placedOrder(tx);
      expect((await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo })).results).toEqual([{ kind: "created", outcome: "permanent" }]);
      expect((await notificationRows(tx, placed.orderId))[0]!.error).toBe(`permanent: email send failed (${status}, ${providerError})`);
      await ageNotifications(tx, placed.orderId, 11);
      await dispatchPendingOrderEmails(tx, deps);
      expect(forOrder(attempts, placed.orderNo)).toHaveLength(1);
    });
  });

  test("a rate limit (429) or a concurrent request (409) is retried", async () => {
    await withRollback(async (tx) => {
      quiet();
      const refusal = Object.assign(new Error("email send failed (429, rate_limit_exceeded)"), { name: "EmailDeliveryError", status: 429, providerError: "rate_limit_exceeded" });
      const { deps } = recorder(() => refusal);
      const placed = await placedOrder(tx);
      expect((await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo })).results).toEqual([{ kind: "created", outcome: "failed" }]);
    });
  });

  test("the cron pass serves orders never tried before retries, and reports a missing owner address apart from failures", async () => {
    await withRollback(async (tx) => {
      quiet();
      await setSupportEmail(tx, null);
      const { deps, sent } = recorder();
      const paid = await placedOrder(tx);
      await applyPaymentStatus(tx, report(paid, "settlement"));
      await dispatchOrderEmails(tx, deps, { orderNo: paid.orderNo });
      await ageNotifications(tx, paid.orderId, 11);
      const fresh = await placedOrder(tx);
      const summary = await dispatchPendingOrderEmails(tx, deps, { limit: 1 });
      expect(forOrder(sent, fresh.orderNo)).toHaveLength(1);
      expect(summary.truncated).toBe(true);
      expect(summary.failed).toBe(0);
    });
  });

  test("a database failure inside dispatch is logged, never thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {
      select: () => {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      },
    } as unknown as Parameters<typeof dispatchOrderEmails>[0];
    const { deps } = recorder();
    await expect(dispatchOrderEmails(broken, deps, { orderNo: "ORD-209801-00000001" })).resolves.toEqual({ orderNo: "ORD-209801-00000001", results: [] });
    expect(error).toHaveBeenCalledWith("[emails] dispatch failed; retried by the cron pass", expect.objectContaining({ code: "ECONNREFUSED" }));
  });
});

// ---------- the expiry sweep ----------

function expiringGateway(): PaymentProvider {
  return {
    ...createFakePaymentProvider({ baseUrl: "http://localhost:3000" }),
    name: "midtrans",
    // No transaction at the gateway (the buyer never picked a method): expired locally.
    async getPaymentStatus() {
      return null;
    },
    async expirePayment() {
      return null;
    },
  };
}

describe("sweep expiry", () => {
  test("an order expired by the sweep gets the cancelled email once, however often the hooks run", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps, sent } = recorder();
      const placed = await placedOrder(tx, { window: "over" });
      const summary = await sweepExpiredPayments(tx, expiringGateway());
      const swept = summary.results.find((row) => row.orderNo === placed.orderNo);
      expect(swept?.result).toBe("expired_locally");
      // What the sweep route does with its results, twice (a retried cron call), then the cron pass.
      for (let round = 0; round < 2; round += 1) {
        for (const row of summary.results) await dispatchOrderEmails(tx, deps, { orderNo: row.orderNo });
      }
      await sweepExpiredPayments(tx, expiringGateway());
      await dispatchPendingOrderEmails(tx, deps);
      const mine = forOrder(sent, placed.orderNo);
      expect(mine.map((message) => message.subject)).toEqual([`Pesanan ${placed.orderNo} dibatalkan`]);
      expect(mine[0]!.body).toContain("belum kami terima sampai batas waktu");
    });
  });

  test("a gateway the sweep cannot ask sends nothing (the order is not ended)", async () => {
    await withRollback(async (tx) => {
      quiet();
      const { deps, sent } = recorder();
      const placed = await placedOrder(tx, { window: "over" });
      const down: PaymentProvider = {
        ...expiringGateway(),
        async getPaymentStatus() {
          throw new PaymentProviderError("unavailable", "down");
        },
      };
      await sweepExpiredPayments(tx, down);
      await dispatchOrderEmails(tx, deps, { orderNo: placed.orderNo });
      expect(forOrder(sent, placed.orderNo)).toEqual([]);
    });
  });
});

// ---------- committed: real concurrency ----------

describe("concurrency", () => {
  test("duplicate notifications at once: one email, one row", async () => {
    quiet();
    const no = orderNo();
    const order = await insertOrder(testDb, { ...checkoutOrderValues(), orderNo: no, contactEmail: `race-${randomUUID()}@example.test`, subtotalAmount: 0, totalAmount: 0, shippingAmount: 0 });
    try {
      const { deps, sent } = recorder();
      const slow = {
        ...deps,
        transport: {
          async send(message: Sent) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            await deps.transport.send(message);
          },
        },
      };
      await Promise.all(Array.from({ length: 5 }, () => dispatchOrderEmails(testDb, slow, { orderNo: no })));
      expect(forOrder(sent, no)).toHaveLength(1);
      expect(await notificationRows(testDb, order.id)).toHaveLength(1);
    } finally {
      await testDb.delete(orderNotifications).where(eq(orderNotifications.orderId, order.id));
      await testDb.delete(orderAccessTokens).where(eq(orderAccessTokens.orderId, order.id));
      await testDb.delete(orders).where(and(eq(orders.id, order.id), inArray(orders.orderNo, [no])));
    }
  });
});

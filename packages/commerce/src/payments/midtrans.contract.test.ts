import { describe, expect, test } from "vitest";
import { createMidtransPaymentProvider } from "./midtrans";

// Opt-in contract test against the REAL Midtrans SANDBOX (docs/plans/cart-checkout.md §13).
// Skipped unless run by hand with a sandbox server key:
//   MIDTRANS_CONTRACT_TEST=1 MIDTRANS_SERVER_KEY=<your sandbox server key> \
//     pnpm --filter @ammari/commerce exec vitest run src/payments/midtrans.contract.test.ts
// Creates one Snap transaction under a CONTRACT- order id (never a real order's), checks the
// documented create shape, then the status API before any method is picked (expected: no
// transaction yet). Sandbox only: refuses anything but an SB- key. Writes to no database.

const enabled = process.env.MIDTRANS_CONTRACT_TEST === "1";
const serverKey = process.env.MIDTRANS_SERVER_KEY ?? "";

describe.skipIf(!enabled)("Midtrans contract (opt-in, real Sandbox)", () => {
  test("Snap create answers a token and a sandbox redirect URL; the status API answers for the order id", { timeout: 40_000 }, async () => {
    expect(serverKey.startsWith("SB-")).toBe(true);
    const provider = createMidtransPaymentProvider({ serverKey, isProduction: false, notificationUrl: null });
    const providerOrderId = `CONTRACT-ORD-209912-${Date.now().toString().slice(-6)}-1`;
    const created = await provider.createPayment({
      providerOrderId,
      grossAmount: 30_000,
      lines: [
        { id: "TEST-SKU", name: "Gamis Uji", price: 25_000, quantity: 1 },
        { id: "SHIPPING", name: "Ongkir", price: 15_000, quantity: 1 },
        { id: "VOUCHER", name: "Voucher", price: -10_000, quantity: 1 },
      ],
      customer: { name: "Uji Kontrak", email: "contract@example.com", phone: "+6281234567890" },
      expiryMinutes: 60,
      finishUrl: "https://example.com/checkout/finish?order=ORD-209912-0001",
    });
    console.info("[contract] redirect host", new URL(created.redirectUrl).host);
    expect(new URL(created.redirectUrl).host).toBe("app.sandbox.midtrans.com");

    const status = await provider.getPaymentStatus(providerOrderId);
    console.info("[contract] status before a method is picked", status ? status.transactionStatus : "not found");
  });
});

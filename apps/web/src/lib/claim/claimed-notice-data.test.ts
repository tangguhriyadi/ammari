import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder, insertThankYouCard } from "@ammari/db/test-fixtures";
import { vouchers } from "@ammari/db/schema";
import { findJustClaimedVoucherExpiry } from "./claimed-notice-data";
import { voucherClaimedMessage } from "./claimed-notice";

// The homepage's claimed notice reads the dates of the voucher the signed-in buyer just claimed
// (lib/claim/claimed-notice-data.ts): only their own, only a fresh one, else no dates at all.

const NOW = new Date("2026-10-22T08:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

async function insertVoucher(tx: TestDatabase, customerId: string, values: { issuedAt: Date; expiresAt: Date; status?: string }) {
  const order = await insertOrder(tx);
  const card = await insertThankYouCard(tx, order.id, { status: "claimed", claimDeadline: new Date(NOW.getTime() + 86_400_000), claimedByCustomerId: customerId, claimedAt: values.issuedAt });
  await tx.insert(vouchers).values({ cardId: card.id, customerId, amount: 20_000, status: values.status ?? "active", issuedAt: values.issuedAt, expiresAt: values.expiresAt });
}

describe("findJustClaimedVoucherExpiry", () => {
  test("the buyer's voucher claimed moments ago: its expiry", async () => {
    await withRollback(async (tx) => {
      const buyer = await insertCustomer(tx);
      await insertVoucher(tx, buyer.id, { issuedAt: minutesAgo(1), expiresAt: new Date("2027-03-01T05:00:00Z") });
      expect(await findJustClaimedVoucherExpiry(buyer.id, tx, NOW)).toEqual(new Date("2027-03-01T05:00:00Z"));
    });
  });

  test("two fresh ones: the newest", async () => {
    await withRollback(async (tx) => {
      const buyer = await insertCustomer(tx);
      await insertVoucher(tx, buyer.id, { issuedAt: minutesAgo(5), expiresAt: new Date("2027-02-01T05:00:00Z") });
      await insertVoucher(tx, buyer.id, { issuedAt: minutesAgo(1), expiresAt: new Date("2027-03-01T05:00:00Z") });
      expect(await findJustClaimedVoucherExpiry(buyer.id, tx, NOW)).toEqual(new Date("2027-03-01T05:00:00Z"));
    });
  });

  test("none fresh, someone else's, or no longer active: null (the plain message)", async () => {
    await withRollback(async (tx) => {
      const buyer = await insertCustomer(tx);
      const other = await insertCustomer(tx);
      await insertVoucher(tx, buyer.id, { issuedAt: minutesAgo(60), expiresAt: new Date("2027-03-01T05:00:00Z") });
      await insertVoucher(tx, buyer.id, { issuedAt: minutesAgo(1), expiresAt: new Date("2027-03-01T05:00:00Z"), status: "void" });
      await insertVoucher(tx, other.id, { issuedAt: minutesAgo(1), expiresAt: new Date("2027-03-01T05:00:00Z") });
      expect(await findJustClaimedVoucherExpiry(buyer.id, tx, NOW)).toBeNull();
    });
  });
});

describe("voucherClaimedMessage", () => {
  test("with the expiry: start and end dates, in WIB", () => {
    // 2027-02-28T18:00Z is already 1 March in Jakarta (UTC+7).
    expect(voucherClaimedMessage(new Date("2027-02-28T18:00:00Z"))).toBe("Voucher sudah masuk ke akunmu. Bisa dipakai mulai 1 Desember 2026 sampai 1 Mar 2027.");
  });

  test("without it: the plain message", () => {
    expect(voucherClaimedMessage(null)).toBe("Voucher sudah masuk ke akunmu.");
  });
});

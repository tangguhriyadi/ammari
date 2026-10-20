import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { stockMovements } from "@ammari/db/schema";
import { createOrder } from "@ammari/commerce/orders";
import { getOrderDetail, stripOrderDetailCost } from "./queries";

// The write-path tests (createOrder, updateOrderItems, transitionOrderStatus,
// generateOrderNumber) moved with that code to packages/commerce/src/orders/lifecycle.test.ts.
// What stays here is the admin read model on top of it.

describe("getOrderDetail", () => {
  test("returns each line with the unit_cost locked when stock left, and stripOrderDetailCost hides it", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: 10, valueAmount: 1_000_000, type: "production", refType: "manual" });

      const order = await createOrder(
        {
          channelId: "whatsapp",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 2, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 10_000,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      const detail = await getOrderDetail(order.id, tx);
      expect(detail?.orderNo).toBe(order.orderNo);
      expect(detail?.totalAmount).toBe(528_000);
      expect(detail?.createdByName).toBe(staff.name);
      expect(detail?.cardClaimedAt).toBeNull();
      expect(detail?.items).toHaveLength(1);
      expect(detail?.items[0]).toMatchObject({ sku: variant.sku, size: variant.size, qty: 2, unitPrice: 259_000, unitCost: 100_000 });

      expect(stripOrderDetailCost(detail!, true).items[0]!.unitCost).toBe(100_000);
      expect(stripOrderDetailCost(detail!, false).items[0]!.unitCost).toBeNull();
    });
  });

  test("returns null for an unknown order", async () => {
    await withRollback(async (tx) => {
      expect(await getOrderDetail("00000000-0000-4000-8000-000000000000", tx)).toBeNull();
    });
  });
});

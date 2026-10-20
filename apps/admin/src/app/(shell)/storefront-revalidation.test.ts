import { beforeEach, describe, expect, test, vi } from "vitest";

// Wiring test: every admin action that moves sellable finished-goods stock must ask the
// storefront to refresh the affected products (lib/storefront-stock.ts), and one that cannot
// reach the storefront must still succeed and say so. The lib layers are mocked; what is asserted
// is the action's own behaviour.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
vi.mock("@/lib/admin-revalidate", () => ({ revalidateAdmin: vi.fn() }));

const m = vi.hoisted(() => ({
  revalidateStorefrontForSkus: vi.fn(),
  skusForOrder: vi.fn(),
  skusForBatchLines: vi.fn(),
  skusForReceipt: vi.fn(),
  saveStockCount: vi.fn(),
  adjustStock: vi.fn(),
  createOrder: vi.fn(),
  transitionOrderStatus: vi.fn(),
  postGoodsReceiptForBatch: vi.fn(),
  reverseGoodsReceipt: vi.fn(),
}));
vi.mock("@/lib/storefront-stock", () => ({
  revalidateStorefrontForSkus: m.revalidateStorefrontForSkus,
  skusForOrder: m.skusForOrder,
  skusForBatchLines: m.skusForBatchLines,
  skusForReceipt: m.skusForReceipt,
}));
vi.mock("@ammari/commerce/stock", () => ({ saveStockCount: m.saveStockCount, adjustStock: m.adjustStock }));
vi.mock("@ammari/commerce/orders", () => ({ createOrder: m.createOrder, transitionOrderStatus: m.transitionOrderStatus }));
vi.mock("@/lib/receipts/production", () => ({ postGoodsReceiptForBatch: m.postGoodsReceiptForBatch, closeBatchShort: vi.fn() }));
vi.mock("@/lib/receipts/queries", () => ({ postGoodsReceiptForPurchase: vi.fn(), reverseGoodsReceipt: m.reverseGoodsReceipt }));

const { saveStockCountAction, adjustStockAction } = await import("./stock/actions");
const { createOrderAction, transitionOrderStatusAction } = await import("./orders/actions");
const { receiveBatchAction } = await import("./production/actions");
const { reverseReceiptAction } = await import("./purchases/actions");

const ALL = ["stock.adjust", "orders.manage", "inventory.receive", "inventory.manage"];
const ID = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";

/** The SKUs the action asked to revalidate: the call's argument, resolved if it is a lookup. */
async function resolved(): Promise<string[]> {
  expect(m.revalidateStorefrontForSkus).toHaveBeenCalledTimes(1);
  const arg = m.revalidateStorefrontForSkus.mock.calls[0]![0];
  return typeof arg === "function" ? await arg() : arg;
}

beforeEach(() => {
  vi.clearAllMocks();
  getStaffSessionMock.mockResolvedValue({
    staffUser: { id: "staff-1", name: "T", email: "t@example.test", roleId: "r" },
    role: { id: "r", key: "t", name: "T" },
    permissionKeys: ALL,
  });
  m.revalidateStorefrontForSkus.mockResolvedValue({ ok: true });
  m.skusForOrder.mockResolvedValue(["SKU-A", "SKU-B"]);
  m.skusForBatchLines.mockResolvedValue(["SKU-R"]);
  m.skusForReceipt.mockResolvedValue(["SKU-R"]);
});

describe("storefront revalidation after stock changes", () => {
  test("a production receipt revalidates the SKUs of its lines", async () => {
    m.postGoodsReceiptForBatch.mockResolvedValue({ receipt: { receiptNo: "GR-1" }, status: "received" });
    const result = await receiveBatchAction({ batchId: ID, receivedAt: "2026-10-01", lines: [{ productionBatchItemId: LINE, qtyAccepted: "3" }] });
    expect(result).toEqual({ ok: true, data: { receiptNo: "GR-1", storefrontOk: true } });
    expect(await resolved()).toEqual(["SKU-R"]);
    expect(m.skusForBatchLines).toHaveBeenCalledWith([LINE]);
  });

  test("a receipt reversal revalidates the SKUs the receipt touched", async () => {
    m.reverseGoodsReceipt.mockResolvedValue({});
    const result = await reverseReceiptAction({ receiptId: ID });
    expect(result).toEqual({ ok: true, data: { storefrontOk: true } });
    expect(await resolved()).toEqual(["SKU-R"]);
    expect(m.skusForReceipt).toHaveBeenCalledWith(ID);
  });

  test("a stock count revalidates only the SKUs it changed", async () => {
    m.saveStockCount.mockResolvedValue({ changedSkus: ["SKU-M", "SKU-L"] });
    const result = await saveStockCountAction({ productId: ID, lines: [{ sku: "SKU-M", physicalQty: 1 }, { sku: "SKU-S", physicalQty: 2 }] });
    expect(result).toEqual({ ok: true, data: { changedSkus: ["SKU-M", "SKU-L"], storefrontOk: true } });
    expect(m.revalidateStorefrontForSkus).toHaveBeenCalledWith(["SKU-M", "SKU-L"]);
  });

  test("a manual stock adjustment revalidates that SKU", async () => {
    m.adjustStock.mockResolvedValue(undefined);
    await adjustStockAction({ sku: "SKU-M", deltaQty: -1, reason: "damaged" });
    expect(m.revalidateStorefrontForSkus).toHaveBeenCalledWith(["SKU-M"]);
  });

  test("an order created as to_ship (stock deducted) revalidates its SKUs; awaiting_payment does not", async () => {
    m.createOrder.mockResolvedValue({ id: ID });
    const base = { channelId: "offline" as const, orderDate: "2026-10-01", discountAmount: "", shippingAmount: "", items: [{ sku: "SKU-A", qty: 1, unitPrice: "100000" }] };

    await createOrderAction({ ...base, status: "to_ship" });
    expect(m.revalidateStorefrontForSkus).toHaveBeenCalledTimes(1);
    expect(m.revalidateStorefrontForSkus).toHaveBeenCalledWith(["SKU-A"]);

    m.revalidateStorefrontForSkus.mockClear();
    await createOrderAction({ ...base, status: "awaiting_payment" });
    expect(m.revalidateStorefrontForSkus).not.toHaveBeenCalled();
  });

  test("order transitions that move stock (payment confirmed, cancel, return) revalidate; shipped does not", async () => {
    m.transitionOrderStatus.mockImplementation(async (_id: string, status: string) => ({ status }));
    for (const toStatus of ["to_ship", "cancelled", "returned"] as const) {
      m.revalidateStorefrontForSkus.mockClear();
      await transitionOrderStatusAction({ orderId: ID, toStatus });
      expect(await resolved()).toEqual(["SKU-A", "SKU-B"]);
    }
    m.revalidateStorefrontForSkus.mockClear();
    await transitionOrderStatusAction({ orderId: ID, toStatus: "shipped" });
    expect(m.revalidateStorefrontForSkus).not.toHaveBeenCalled();
  });

  test("a failed storefront call never fails the action; it is reported as storefrontOk: false", async () => {
    m.revalidateStorefrontForSkus.mockResolvedValue({ ok: false });
    m.saveStockCount.mockResolvedValue({ changedSkus: ["SKU-M"] });
    const result = await saveStockCountAction({ productId: ID, lines: [{ sku: "SKU-M", physicalQty: 1 }] });
    expect(result).toEqual({ ok: true, data: { changedSkus: ["SKU-M"], storefrontOk: false } });
  });

  test("a failed stock action does not revalidate anything", async () => {
    m.adjustStock.mockRejectedValue(new Error("db down"));
    await expect(adjustStockAction({ sku: "SKU-M", deltaQty: -1, reason: "damaged" })).rejects.toThrow();
    expect(m.revalidateStorefrontForSkus).not.toHaveBeenCalled();
  });
});

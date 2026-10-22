import { describe, expect, test } from "vitest";
import { ORDER_VIEW_INDEX_MAX, addToOrderViewIndex, orderViewCookieName, parseOrderViewIndex, serializeOrderViewIndex } from "./view-cookie";

// The index cookie that lets logout find every path-scoped "Lihat pesanan" cookie.

const orderNo = (n: number) => `ORD-261022-${String(n).padStart(4, "0")}`;

describe("order view index", () => {
  test("round-trips, oldest first", () => {
    const value = serializeOrderViewIndex([orderNo(1), orderNo(2)]);
    expect(parseOrderViewIndex(value)).toEqual([orderNo(1), orderNo(2)]);
  });

  test("keeps only order numbers, once each, at most the cap", () => {
    expect(parseOrderViewIndex(undefined)).toEqual([]);
    expect(parseOrderViewIndex("")).toEqual([]);
    expect(parseOrderViewIndex(`${orderNo(1)}.x.${orderNo(1)}.ORD-1.;Path=/`)).toEqual([orderNo(1)]);
    const many = Array.from({ length: ORDER_VIEW_INDEX_MAX + 5 }, (_, i) => orderNo(i));
    expect(parseOrderViewIndex(serializeOrderViewIndex(many))).toEqual(many.slice(-ORDER_VIEW_INDEX_MAX));
  });

  test("adding moves the order to the newest end", () => {
    expect(addToOrderViewIndex([orderNo(1), orderNo(2)], orderNo(1))).toEqual({ orderNos: [orderNo(2), orderNo(1)], evicted: [] });
    expect(addToOrderViewIndex([], orderNo(3))).toEqual({ orderNos: [orderNo(3)], evicted: [] });
  });

  test("adding past the cap evicts the oldest, whose cookie the response then expires", () => {
    const full = Array.from({ length: ORDER_VIEW_INDEX_MAX }, (_, i) => orderNo(i));
    const { orderNos, evicted } = addToOrderViewIndex(full, orderNo(999));
    expect(evicted).toEqual([orderNo(0)]);
    expect(orderNos).toHaveLength(ORDER_VIEW_INDEX_MAX);
    expect(orderNos.at(-1)).toBe(orderNo(999));
  });

  test("each order has its own cookie name", () => {
    expect(orderViewCookieName(orderNo(1))).toBe("ammari_order_view_ORD-261022-0001");
    expect(orderViewCookieName(orderNo(1))).not.toBe(orderViewCookieName(orderNo(2)));
  });
});

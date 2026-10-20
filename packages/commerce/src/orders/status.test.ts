import { describe, expect, test } from "vitest";
import { ORDER_STATUSES } from "@ammari/db/schema";
import { canTransitionOrderStatus, ORDER_STATUS_TRANSITIONS } from "./status";

describe("canTransitionOrderStatus", () => {
  test("allows exactly the transitions in ORDER_STATUS_TRANSITIONS", () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransitionOrderStatus(from, to)).toBe(ORDER_STATUS_TRANSITIONS[from].includes(to));
      }
    }
  });

  test("shipped can never be cancelled (a failed delivery goes through returned)", () => {
    expect(canTransitionOrderStatus("shipped", "cancelled")).toBe(false);
    expect(canTransitionOrderStatus("shipped", "returned")).toBe(true);
  });

  test("cancelled and returned are terminal", () => {
    expect(ORDER_STATUS_TRANSITIONS.cancelled).toEqual([]);
    expect(ORDER_STATUS_TRANSITIONS.returned).toEqual([]);
  });
});

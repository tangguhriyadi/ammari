import { describe, expect, test } from "vitest";
import type { OrderStatus } from "@ammari/db/schema";
import { shopeeAdapter } from "./adapters/shopee";
import type { StatusRule } from "./adapters/types";
import { decideStatus } from "./status-rules";

const rule = (raw: string): StatusRule | undefined => shopeeAdapter.statusMap[raw]?.rule;
const existing = (status: OrderStatus, returnPending = false) => ({ status, returnPending });

describe("a marketplace order not yet in admin", () => {
  test("Belum Bayar is skipped (not a sale yet)", () => {
    expect(decideStatus(rule("belum bayar"), null)).toEqual({ kind: "skip", reason: "unpaid" });
  });

  test("Batal is skipped (it never existed for us)", () => {
    expect(decideStatus(rule("batal"), null)).toEqual({ kind: "skip", reason: "undone_before_import" });
  });

  test("Perlu Dikirim is created at Siap Kirim", () => {
    expect(decideStatus(rule("perlu dikirim"), null)).toEqual({ kind: "create", transitions: [], setReturnPending: false });
  });

  test("Dikirim and Sedang Dikirim are created and moved to shipped", () => {
    for (const raw of ["dikirim", "sedang dikirim"]) {
      expect(decideStatus(rule(raw), null)).toEqual({ kind: "create", transitions: ["shipped"], setReturnPending: false });
    }
  });

  test("Selesai is created and walked forward to completed", () => {
    expect(decideStatus(rule("selesai"), null)).toEqual({ kind: "create", transitions: ["shipped", "completed"], setReturnPending: false });
  });

  test("Dalam Pengembalian is created as shipped and flagged, never returned yet", () => {
    expect(decideStatus(rule("dalam pengembalian"), null)).toEqual({ kind: "create", transitions: ["shipped"], setReturnPending: true });
  });

  test("an unknown status waits for review", () => {
    expect(decideStatus(undefined, null)).toMatchObject({ kind: "review", reason: "unknown_status" });
  });
});

describe("an order already in admin", () => {
  test("moves forward only, one allowed step at a time", () => {
    expect(decideStatus(rule("dikirim"), existing("to_ship"))).toEqual({ kind: "update", transitions: ["shipped"], setReturnPending: false, clearReturnPending: false });
    expect(decideStatus(rule("selesai"), existing("to_ship"))).toEqual({
      kind: "update",
      transitions: ["shipped", "completed"],
      setReturnPending: false,
      clearReturnPending: false,
    });
    expect(decideStatus(rule("selesai"), existing("shipped"))).toEqual({ kind: "update", transitions: ["completed"], setReturnPending: false, clearReturnPending: false });
  });

  test("an older file never moves an order back", () => {
    expect(decideStatus(rule("perlu dikirim"), existing("shipped"))).toEqual({ kind: "unchanged" });
    expect(decideStatus(rule("dikirim"), existing("completed"))).toEqual({ kind: "unchanged" });
    expect(decideStatus(rule("belum bayar"), existing("to_ship"))).toEqual({ kind: "unchanged" });
    expect(decideStatus(rule("selesai"), existing("completed"))).toEqual({ kind: "unchanged" });
  });

  test("a manual order still waiting for payment moves on to Siap Kirim", () => {
    expect(decideStatus(rule("perlu dikirim"), existing("awaiting_payment"))).toEqual({
      kind: "update",
      transitions: ["to_ship"],
      setReturnPending: false,
      clearReturnPending: false,
    });
  });

  test("Batal before shipping cancels (stock comes back through the lifecycle)", () => {
    expect(decideStatus(rule("batal"), existing("to_ship"))).toEqual({ kind: "update", transitions: ["cancelled"], setReturnPending: false, clearReturnPending: false });
    expect(decideStatus(rule("batal"), existing("awaiting_payment"))).toEqual({
      kind: "update",
      transitions: ["cancelled"],
      setReturnPending: false,
      clearReturnPending: false,
    });
  });

  test("Batal after admin shipped is a return (shipped -> cancelled is not allowed; decision 4)", () => {
    expect(decideStatus(rule("batal"), existing("shipped"))).toEqual({ kind: "update", transitions: ["returned"], setReturnPending: false, clearReturnPending: false });
    expect(decideStatus(rule("batal"), existing("completed"))).toEqual({ kind: "update", transitions: ["returned"], setReturnPending: false, clearReturnPending: false });
  });

  test("a final return before shipping is a cancel (to_ship -> returned is not allowed)", () => {
    const finalReturn: StatusRule = { kind: "status", status: "returned" };
    expect(decideStatus(finalReturn, existing("to_ship"))).toEqual({ kind: "update", transitions: ["cancelled"], setReturnPending: false, clearReturnPending: false });
  });

  test("Dalam Pengembalian flags, moves a not-yet-shipped order to shipped, and never returns it", () => {
    expect(decideStatus(rule("dalam pengembalian"), existing("completed"))).toEqual({
      kind: "update",
      transitions: [],
      setReturnPending: true,
      clearReturnPending: false,
    });
    expect(decideStatus(rule("dalam pengembalian"), existing("to_ship"))).toEqual({
      kind: "update",
      transitions: ["shipped"],
      setReturnPending: true,
      clearReturnPending: false,
    });
    expect(decideStatus(rule("dalam pengembalian"), existing("completed", true))).toEqual({ kind: "unchanged" });
  });

  test("a later final return status returns the flagged order and clears the flag", () => {
    const finalReturn: StatusRule = { kind: "status", status: "returned" };
    expect(decideStatus(finalReturn, existing("completed", true))).toEqual({
      kind: "update",
      transitions: ["returned"],
      setReturnPending: false,
      clearReturnPending: true,
    });
  });

  test("an older file (Selesai, Dikirim) never clears a pending return; a rejected return is settled by hand", () => {
    expect(decideStatus(rule("selesai"), existing("completed", true))).toEqual({ kind: "unchanged" });
    expect(decideStatus(rule("dikirim"), existing("completed", true))).toEqual({ kind: "unchanged" });
  });

  test("Batal on a flagged shipped order returns it and clears the flag", () => {
    expect(decideStatus(rule("batal"), existing("shipped", true))).toEqual({ kind: "update", transitions: ["returned"], setReturnPending: false, clearReturnPending: true });
  });

  test("a flag left on an order already returned or cancelled in admin is cleared", () => {
    expect(decideStatus(rule("batal"), existing("returned", true))).toEqual({ kind: "update", transitions: [], setReturnPending: false, clearReturnPending: true });
    expect(decideStatus({ kind: "status", status: "returned" }, existing("cancelled", true))).toEqual({
      kind: "update",
      transitions: [],
      setReturnPending: false,
      clearReturnPending: true,
    });
  });

  test("Dalam Pengembalian on a manual order still waiting for payment walks it to shipped and flags it", () => {
    expect(decideStatus(rule("dalam pengembalian"), existing("awaiting_payment"))).toEqual({
      kind: "update",
      transitions: ["to_ship", "shipped"],
      setReturnPending: true,
      clearReturnPending: false,
    });
  });

  test("a cancelled or returned admin order is never revived", () => {
    expect(decideStatus(rule("selesai"), existing("cancelled"))).toMatchObject({ kind: "review", reason: "final_in_admin" });
    expect(decideStatus(rule("perlu dikirim"), existing("returned"))).toMatchObject({ kind: "review", reason: "final_in_admin" });
    expect(decideStatus(rule("dalam pengembalian"), existing("returned"))).toMatchObject({ kind: "review", reason: "final_in_admin" });
  });

  test("both sides undone is nothing to do", () => {
    expect(decideStatus(rule("batal"), existing("cancelled"))).toEqual({ kind: "unchanged" });
    expect(decideStatus(rule("batal"), existing("returned"))).toEqual({ kind: "unchanged" });
    expect(decideStatus({ kind: "status", status: "returned" }, existing("cancelled"))).toEqual({ kind: "unchanged" });
  });

  test("an unknown status waits for review", () => {
    expect(decideStatus(undefined, existing("to_ship"))).toMatchObject({ kind: "review", reason: "unknown_status" });
  });
});

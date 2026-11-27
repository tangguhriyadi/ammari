import { describe, expect, test } from "vitest";
import { applyAllowlist, type AllowlistSpec } from "../src/allowlist";

// A fixture full of buyer fields (§6): none may survive, at any depth.
const BUYER_VALUES = ["Siti Buyer", "+62 812-0000-0000", "siti@example.test", "Jl. Contoh No. 1", "buyer-user-123", "Tolong bungkus rapi"];

const raw = {
  id: "576461413038785752",
  status: "AWAITING_SHIPMENT",
  update_time: 1700000000,
  is_on_hold_order: false,
  user_id: "buyer-user-123",
  buyer_email: "siti@example.test",
  buyer_message: "Tolong bungkus rapi",
  recipient_address: { name: "Siti Buyer", phone_number: "+62 812-0000-0000", full_address: "Jl. Contoh No. 1", district_info: [{ address_name: "Jl. Contoh No. 1" }] },
  payment: { sub_total: "250000", seller_discount: "10000", buyer_name: "Siti Buyer" },
  line_items: [
    { id: "li-1", seller_sku: "POKA-FZ-SAGE-M", sale_price: "125000", buyer_phone: "+62 812-0000-0000" },
    { id: "li-2", seller_sku: "POKA-FZ-SAGE-L", sale_price: "125000", extra: { email: "siti@example.test" } },
    "not-an-object",
  ],
  // A key on the list as a scalar, but TikTok sent an object: dropped whole.
  tracking_number: { recipient: "Siti Buyer" },
  tags: ["a", "b"],
  mixed: ["a", { name: "Siti Buyer" }],
  new_field_tiktok_adds_later: "Siti Buyer",
};

const spec: AllowlistSpec = {
  id: true,
  status: true,
  update_time: true,
  is_on_hold_order: true,
  payment: { sub_total: true, seller_discount: true },
  line_items: [{ id: true, seller_sku: true, sale_price: true, extra: { sku: true } }],
  tracking_number: true,
  tags: true,
  mixed: true,
  missing_field: true,
};

describe("applyAllowlist", () => {
  const result = applyAllowlist(raw, spec);

  test("keeps exactly the allowlisted fields", () => {
    expect(result).toEqual({
      id: "576461413038785752",
      status: "AWAITING_SHIPMENT",
      update_time: 1700000000,
      is_on_hold_order: false,
      payment: { sub_total: "250000", seller_discount: "10000" },
      line_items: [
        { id: "li-1", seller_sku: "POKA-FZ-SAGE-M", sale_price: "125000" },
        { id: "li-2", seller_sku: "POKA-FZ-SAGE-L", sale_price: "125000", extra: {} },
      ],
      tags: ["a", "b"],
    });
  });

  test("no buyer value survives anywhere, including nested objects and arrays", () => {
    const text = JSON.stringify(result);
    for (const value of BUYER_VALUES) expect(text).not.toContain(value);
  });

  test("does not mutate the input", () => {
    expect(raw.recipient_address.name).toBe("Siti Buyer");
    expect(raw.line_items[0]).toHaveProperty("buyer_phone");
  });

  test("non-object input gives an empty object", () => {
    for (const value of [null, undefined, "x", 1, [raw]]) expect(applyAllowlist(value, spec)).toEqual({});
  });

  test("a __proto__ key stays a plain own property and never changes a prototype", () => {
    const withProto = JSON.parse('{"__proto__": {"code": "x", "name": "Siti Buyer"}, "id": "1"}') as unknown;
    const protoSpec = JSON.parse('{"id": true, "__proto__": {"code": true}}') as AllowlistSpec;
    const kept = applyAllowlist(withProto, protoSpec);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(Object.hasOwn(kept, "__proto__")).toBe(true);
    expect(JSON.stringify(kept)).toBe('{"id":"1","__proto__":{"code":"x"}}');
  });

  test("inherited keys are never read", () => {
    const inherited = Object.create({ id: "inherited" }) as object;
    expect(applyAllowlist(inherited, { id: true })).toEqual({});
  });

  test("an array rule refuses a non-array value", () => {
    expect(applyAllowlist({ line_items: { id: "x" } }, spec)).toEqual({});
  });
});

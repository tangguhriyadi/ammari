import { describe, expect, test } from "vitest";
import type { ChannelId } from "@ammari/db/schema";
import { assignStickerCodes, buildStickerCodeBase, CHANNEL_STICKER_CODE, type StickerCodeOrderInput } from "./sticker-code";

function order(overrides: Partial<StickerCodeOrderInput> = {}): StickerCodeOrderInput {
  return {
    orderId: "order-1",
    channelId: "shopee",
    orderNo: "ORD-251015-0012",
    channelOrderNo: "SH-ABCD-4281",
    items: [{ productName: "Cyra", colorName: "Sage", size: "S", qty: 1 }],
    ...overrides,
  };
}

describe("CHANNEL_STICKER_CODE", () => {
  test("covers every channel with the owner's exact codes", () => {
    const expected: Record<ChannelId, string> = {
      shopee: "SHP",
      tiktok: "TTS",
      web: "WEB",
      whatsapp: "WA",
      instagram: "IG",
      offline: "OFF",
      reseller: "RSL",
    };
    expect(CHANNEL_STICKER_CODE).toEqual(expected);
  });
});

describe("buildStickerCodeBase", () => {
  test("matches the owner's worked example (SHP-CY-SA-S-4281)", () => {
    expect(buildStickerCodeBase(order())).toBe("SHP-CY-SA-S-4281");
  });

  test.each(Object.entries(CHANNEL_STICKER_CODE) as [ChannelId, string][])(
    "renders the %s channel as %s",
    (channelId, code) => {
      const result = buildStickerCodeBase(order({ channelId, channelOrderNo: channelId === "shopee" || channelId === "tiktok" ? "XX-1234" : null }));
      expect(result.startsWith(`${code}-`)).toBe(true);
    },
  );

  test("LAST4 comes from channelOrderNo for shopee/tiktok", () => {
    const code = buildStickerCodeBase(order({ channelId: "tiktok", channelOrderNo: "TT9988776655", orderNo: "ORD-000000-0000" }));
    expect(code.endsWith("-6655")).toBe(true);
  });

  test("LAST4 comes from orderNo for non-marketplace channels, even if channelOrderNo is set", () => {
    const code = buildStickerCodeBase(order({ channelId: "whatsapp", channelOrderNo: "SHOULD-NOT-BE-USED-9999", orderNo: "ORD-251015-1234" }));
    expect(code.endsWith("-1234")).toBe(true);
  });

  test("falls back to orderNo when a marketplace order has no channelOrderNo", () => {
    const code = buildStickerCodeBase(order({ channelId: "shopee", channelOrderNo: null, orderNo: "ORD-251015-7777" }));
    expect(code.endsWith("-7777")).toBe(true);
  });

  test("ALLSIZE renders as AS", () => {
    const code = buildStickerCodeBase(order({ items: [{ productName: "Cyra", colorName: "Sage", size: "ALLSIZE", qty: 1 }] }));
    expect(code).toBe("SHP-CY-SA-AS-4281");
  });

  test.each(["XS", "S", "M", "L", "XL"] as const)("size %s renders as-is", (size) => {
    const code = buildStickerCodeBase(order({ items: [{ productName: "Cyra", colorName: "Sage", size, qty: 1 }] }));
    expect(code).toBe(`SHP-CY-SA-${size}-4281`);
  });

  test("strips accents before taking the first 2 letters", () => {
    const code = buildStickerCodeBase(order({ items: [{ productName: "Éclair", colorName: "Crème", size: "M", qty: 1 }] }));
    expect(code).toBe("SHP-EC-CR-M-4281");
  });

  test("strips non-letter characters (numbers, punctuation) before taking the first 2 letters", () => {
    const code = buildStickerCodeBase(order({ items: [{ productName: "2Gamis-Cantik", colorName: "99Sage!", size: "M", qty: 1 }] }));
    expect(code).toBe("SHP-GA-SA-M-4281");
  });

  test("a single item with qty 1 gets no 'x{n}' suffix", () => {
    expect(buildStickerCodeBase(order())).not.toContain(" x");
  });

  test("a single item with qty > 1 is multi-piece and appends the suffix", () => {
    const code = buildStickerCodeBase(order({ items: [{ productName: "Cyra", colorName: "Sage", size: "S", qty: 3 }] }));
    expect(code).toBe("SHP-CY-SA-S-4281 x3");
  });

  test("multiple items sum qty for the suffix and use the first item (by product, color, size) for the base", () => {
    const code = buildStickerCodeBase(
      order({
        items: [
          { productName: "Zahra", colorName: "Black", size: "L", qty: 1 },
          { productName: "Cyra", colorName: "Sage", size: "S", qty: 1 },
        ],
      }),
    );
    // "Cyra" < "Zahra" alphabetically -> Cyra/Sage/S wins the stable sort.
    expect(code).toBe("SHP-CY-SA-S-4281 x2");
  });

  test("the stable sort breaks ties on color, then size, after product name", () => {
    const code = buildStickerCodeBase(
      order({
        items: [
          { productName: "Cyra", colorName: "Zink", size: "L", qty: 1 },
          { productName: "Cyra", colorName: "Amber", size: "S", qty: 1 },
        ],
      }),
    );
    expect(code).toBe("SHP-CY-AM-S-4281 x2");
  });

  test("last4Length=6 widens LAST4 to 6 characters (used by assignStickerCodes on collision)", () => {
    const code = buildStickerCodeBase(order({ channelOrderNo: "SH-ABCD-654281" }), 6);
    expect(code).toBe("SHP-CY-SA-S-654281");
  });

  test("throws for an order with no items (defensive — every real order has at least one)", () => {
    expect(() => buildStickerCodeBase(order({ items: [] }))).toThrow();
  });
});

describe("assignStickerCodes", () => {
  test("no collisions: every order gets its plain 4-char base code", () => {
    const a = order({ orderId: "a", channelOrderNo: "XX-1111" });
    const b = order({ orderId: "b", channelOrderNo: "XX-2222", items: [{ productName: "Zahra", colorName: "Black", size: "M", qty: 1 }] });
    const result = assignStickerCodes([a, b]);
    expect(result.get("a")).toBe("SHP-CY-SA-S-1111");
    expect(result.get("b")).toBe("SHP-ZA-BL-M-2222");
  });

  test("two pending orders colliding on the base code both get widened to 6-char LAST4", () => {
    // Both end in "4281" (same base code), but differ further back -> different 6-char codes.
    const a = order({ orderId: "a", channelOrderNo: "111111994281" });
    const b = order({ orderId: "b", channelOrderNo: "222222774281" });
    const result = assignStickerCodes([a, b]);
    expect(result.get("a")).toBe("SHP-CY-SA-S-994281");
    expect(result.get("b")).toBe("SHP-CY-SA-S-774281");
    expect(result.get("a")).not.toBe(result.get("b"));
  });

  test("a pending order colliding with an already-persisted (fixed) code is widened; the fixed one is untouched", () => {
    const a = order({ orderId: "a", channelOrderNo: "111111994281" });
    const result = assignStickerCodes([a], [{ orderId: "existing", code: "SHP-CY-SA-S-4281" }]);
    expect(result.get("a")).toBe("SHP-CY-SA-S-994281");
    // The fixed entry itself is never part of the returned map — callers already know its code.
    expect(result.has("existing")).toBe(false);
  });

  test("non-colliding orders are unaffected by unrelated fixed codes", () => {
    const a = order({ orderId: "a", channelOrderNo: "XX-1111" });
    const result = assignStickerCodes([a], [{ orderId: "existing", code: "TTS-ZA-BL-M-9999" }]);
    expect(result.get("a")).toBe("SHP-CY-SA-S-1111");
  });

  test("an empty pending list returns an empty map", () => {
    expect(assignStickerCodes([], [{ orderId: "x", code: "ANY-CODE" }]).size).toBe(0);
  });
});

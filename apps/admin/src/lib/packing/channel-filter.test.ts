import { describe, expect, test } from "vitest";
import { resolvePackingChannelFilter } from "./channel-filter";

const CHANNELS = [
  { id: "whatsapp" as const },
  { id: "instagram" as const },
  { id: "offline" as const },
  { id: "shopee" as const },
];

describe("resolvePackingChannelFilter", () => {
  test("no ?channel= param (undefined) means 'Semua' — no filter", () => {
    expect(resolvePackingChannelFilter(undefined, CHANNELS)).toBeUndefined();
  });

  test("a real channel id resolves to itself", () => {
    expect(resolvePackingChannelFilter("whatsapp", CHANNELS)).toBe("whatsapp");
  });

  test("an unknown/stale/typo'd value is treated as no filter, not a filter matching nothing", () => {
    expect(resolvePackingChannelFilter("not-a-real-channel", CHANNELS)).toBeUndefined();
  });

  test("an empty string is treated as no filter", () => {
    expect(resolvePackingChannelFilter("", CHANNELS)).toBeUndefined();
  });
});

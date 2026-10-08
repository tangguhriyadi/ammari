import { describe, expect, test } from "vitest";
import { stockStatus } from "./status";

describe("stockStatus", () => {
  test("zero stock is always habis, even with no minimum set", () => {
    expect(stockStatus(0, 0)).toBe("habis");
  });

  test("negative stock (should never happen, but stays defensive) is still habis", () => {
    expect(stockStatus(-1, 5)).toBe("habis");
  });

  test("at or below a positive minimum is menipis", () => {
    expect(stockStatus(5, 5)).toBe("menipis");
    expect(stockStatus(3, 5)).toBe("menipis");
  });

  test("above the minimum is ok", () => {
    expect(stockStatus(6, 5)).toBe("ok");
  });

  test("a positive stock with no minimum set (0) is ok, never menipis", () => {
    expect(stockStatus(1, 0)).toBe("ok");
  });
});

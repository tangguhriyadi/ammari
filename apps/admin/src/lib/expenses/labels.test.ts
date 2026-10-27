import { describe, expect, test } from "vitest";
import { joinCategoryLabels } from "./labels";

describe("joinCategoryLabels", () => {
  test("Indonesian list of category labels", () => {
    expect(joinCategoryLabels(["rent"])).toBe("Sewa");
    expect(joinCategoryLabels(["salary", "rent"])).toBe("Gaji dan Sewa");
    expect(joinCategoryLabels(["salary", "rent", "utilities"])).toBe("Gaji, Sewa, dan Utilitas");
  });
});

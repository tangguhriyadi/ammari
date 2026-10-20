import { describe, expect, test, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { revalidateAdmin } from "./admin-revalidate";

// next/cache is mocked for every test file in test/setup.ts.
describe("revalidateAdmin", () => {
  test("revalidates each section as a layout under the (shell) route group", () => {
    vi.mocked(revalidatePath).mockClear();
    revalidateAdmin("/products", "/stock");
    // Without the group segment the tag would never match: revalidatePath's tags come from the
    // route's file path, app/(shell)/products/..., not from the URL.
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([
      ["/(shell)/products", "layout"],
      ["/(shell)/stock", "layout"],
    ]);
  });
});

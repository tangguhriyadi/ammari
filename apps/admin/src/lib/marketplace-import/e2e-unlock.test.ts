import { describe, expect, test } from "vitest";
import { e2eMappingUnlocked } from "./e2e-unlock";

// The e2e-only mapping unlock fails closed outside a local e2e run (docs/plans/marketplace-import.md
// §2.1; the adapter constant itself is never changed by a test).
describe("e2eMappingUnlocked", () => {
  const e2e = { nodeEnv: "development", e2eTestLoginFlag: "true", cookieValue: "shopee", channelId: "shopee" };

  test("only in a local e2e run, only for the channel the cookie names", () => {
    expect(e2eMappingUnlocked(e2e)).toBe(true);
    expect(e2eMappingUnlocked({ ...e2e, channelId: "tiktok" })).toBe(false);
    expect(e2eMappingUnlocked({ ...e2e, cookieValue: undefined })).toBe(false);
    expect(e2eMappingUnlocked({ ...e2e, cookieValue: "" })).toBe(false);
  });

  test("never in production, never without E2E_TEST_LOGIN=true", () => {
    expect(e2eMappingUnlocked({ ...e2e, nodeEnv: "production" })).toBe(false);
    expect(e2eMappingUnlocked({ ...e2e, e2eTestLoginFlag: undefined })).toBe(false);
    expect(e2eMappingUnlocked({ ...e2e, e2eTestLoginFlag: "1" })).toBe(false);
  });
});

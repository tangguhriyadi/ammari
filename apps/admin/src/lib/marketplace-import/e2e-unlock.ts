// The e2e-only way past the Shopee mapping lock (docs/plans/marketplace-import.md §2.1, session 5).
// SHOPEE_MAPPING_VERIFIED stays false in code; an e2e test that exercises Simpan sets this cookie in
// its own setup, and the import actions honour it only in a local e2e run. Same fail-closed
// conditions as the e2e sign-in backdoor (e2e-login-gate.ts): never in production, never without
// E2E_TEST_LOGIN=true (set only by playwright.config.ts's webServer env, whose server binds to
// 127.0.0.1). A real deployment can never see the cookie take effect.

export const E2E_MAPPING_UNLOCK_COOKIE = "e2e_marketplace_mapping_verified";

export interface E2eMappingUnlockInput {
  nodeEnv: string | undefined;
  e2eTestLoginFlag: string | undefined;
  /** The cookie's value: the channel id it unlocks. */
  cookieValue: string | undefined;
  channelId: string;
}

export function e2eMappingUnlocked(input: E2eMappingUnlockInput): boolean {
  if (input.nodeEnv === "production") return false;
  if (input.e2eTestLoginFlag !== "true") return false;
  return input.cookieValue !== undefined && input.cookieValue === input.channelId;
}

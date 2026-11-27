import "server-only";
import type { FetchLike } from "@ammari/tiktok-shop";

// An in-memory TikTok Shop for e2e runs (TIKTOK_PROVIDER=fake, accepted only with E2E_TEST_LOGIN in
// a non-production build, ./runtime.ts). Answers the auth host and Get Authorized Shops; nothing
// leaves the process. Every value is a dummy.

export const FAKE_TIKTOK_AUTH_BASE_URL = "https://auth.tiktok.fake";
export const FAKE_TIKTOK_API_BASE_URL = "https://api.tiktok.fake";

/** The code e2e passes to the callback for a successful connect. Any other code is refused the
 * way TikTok refuses a used or expired one. */
export const FAKE_TIKTOK_GOOD_CODE = "e2e-good-code";
export const FAKE_TIKTOK_SHOP = { id: "7000000000000000001", name: "Ammari E2E", region: "ID", seller_type: "LOCAL", cipher: "ROW_e2e_cipher" } as const;
export const FAKE_TIKTOK_SCOPES = ["seller.finance.info", "seller.logistics", "seller.order.info", "seller.product.basic", "seller.return_refund.basic", "seller.shop.info"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function createFakeTikTokFetch(now: () => number = Date.now): FetchLike {
  let issued = 0;
  return async (input) => {
    const url = new URL(input);
    const nowS = Math.floor(now() / 1000);
    const tokens = () => {
      issued += 1;
      return json({
        code: 0,
        message: "success",
        request_id: `fake-${issued}`,
        data: {
          access_token: `ROW_fake_access_${issued}`,
          access_token_expire_in: nowS + 7 * 86_400,
          refresh_token: `ROW_fake_refresh_${issued}`,
          refresh_token_expire_in: nowS + 365 * 86_400,
          seller_name: FAKE_TIKTOK_SHOP.name,
          seller_base_region: "ID",
          granted_scopes: FAKE_TIKTOK_SCOPES,
        },
      });
    };
    if (url.origin === FAKE_TIKTOK_AUTH_BASE_URL && url.pathname === "/api/v2/token/get") {
      if (url.searchParams.get("grant_type") !== "authorized_code") return json({ code: 36004004, message: "invalid grant", request_id: "fake-grant" });
      return url.searchParams.get("auth_code") === FAKE_TIKTOK_GOOD_CODE ? tokens() : json({ code: 36004004, message: "auth code invalid", request_id: "fake-code" });
    }
    if (url.origin === FAKE_TIKTOK_AUTH_BASE_URL && url.pathname === "/api/v2/token/refresh") return tokens();
    if (url.origin === FAKE_TIKTOK_API_BASE_URL && url.pathname === "/authorization/202309/shops") {
      return json({ code: 0, message: "Success", request_id: "fake-shops", data: { shops: [FAKE_TIKTOK_SHOP] } });
    }
    return json({ code: 40001, message: "not found", request_id: "fake-404" }, 404);
  };
}

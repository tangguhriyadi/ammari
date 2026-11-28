import "server-only";
import type { StaffSessionData } from "@ammari/auth/staff";
import { errorLogFields } from "@ammari/commerce/errors";
import { consumeTikTokOAuthState, saveTikTokConnection, tiktokRuntimeFromEnv, type TikTokRuntimeOptions, type TikTokRuntimeResult } from "@ammari/commerce/tiktok";
import { Secret, TikTokApiError, getAuthorizedShops } from "@ammari/tiktok-shop";
import type { Database } from "@/lib/db";
import type { TikTokConnectErrorCode } from "./tiktok-messages";

// The admin side of the TikTok Shop connection (docs/plans/tiktok-shop-integration.md §7.3).

export const TIKTOK_INTEGRATION_PATH = "/settings/integrations/tiktok";
export const TIKTOK_PERMISSION = "integrations.manage" as const;

export function getTikTokRuntime(options: Omit<TikTokRuntimeOptions, "fetch" | "now"> = {}): TikTokRuntimeResult {
  return tiktokRuntimeFromEnv(process.env, options);
}

// The authorization code is opaque; only obvious garbage is refused before it reaches TikTok.
const CODE_PATTERN = /^[\x21-\x7e]{1,1024}$/;
const STATE_MAX_LENGTH = 128;
const SHOPS_BUDGET_MS = 15_000;

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  // The callback URL holds the one-time code and the state: never sent on as a Referer.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: location } });
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403, headers: { ...NO_STORE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}

function failed(code: TikTokConnectErrorCode, error?: TikTokApiError): Response {
  // One line, reason and TikTok's error fields only: never the code, the state, a token or the URL.
  // `detail` (on invalid_response) names the failing field or expiry, never a value (T0).
  console.warn("[tiktok-connect] failed", { reason: code, ...(error ? error.toJSON() : {}) });
  return redirectTo(`${TIKTOK_INTEGRATION_PATH}?error=${code}`);
}

function apiErrorCode(error: TikTokApiError, stage: "token" | "shops"): TikTokConnectErrorCode {
  switch (error.kind) {
    case "network":
    case "unavailable":
    case "rate_limited":
    case "budget_exhausted":
      return "tiktok_unavailable";
    case "invalid_response":
      return "invalid_response";
    case "api":
      // A code that works once and for 30 minutes (§0): TikTok refusing it in its normal envelope
      // (HTTP 200, non-zero code) means used or expired. Any other refusal (a 4xx) is a setup
      // problem, not the person's code; the log line carries TikTok's code for the owner.
      return stage === "token" && error.httpStatus === 200 ? "code_rejected" : "failed";
    default:
      return "failed";
  }
}

export interface TikTokCallbackInput {
  url: URL;
  session: StaffSessionData | null;
  db: Database;
  runtime: TikTokRuntimeResult;
  now?: Date;
}

/** GET /api/integrations/tiktok/callback (§7.3 step 2). Staff with `integrations.manage` only
 * (403 otherwise, before anything is read); the state is consumed atomically for this staff user;
 * the code is exchanged at once (it works once, for 30 minutes); then Get Authorized Shops and the
 * upsert under the connection lock. Every outcome redirects to the Integrasi page with a short code. */
export async function handleTikTokCallback(input: TikTokCallbackInput): Promise<Response> {
  const { session, db, url } = input;
  if (!session || !session.permissionKeys.includes(TIKTOK_PERMISSION)) return forbidden();
  const now = input.now ?? new Date();

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state.length > STATE_MAX_LENGTH) return failed("missing_params");
  // Burn the state first, whatever else is wrong: it never works twice.
  if (!(await consumeTikTokOAuthState(db, state, session.staffUser.id, now))) return failed("state_invalid");
  if (!code || !CODE_PATTERN.test(code)) return failed("missing_params");
  if (!input.runtime.ok) {
    console.warn("[tiktok-connect] integration not configured", { problems: input.runtime.problems });
    return failed("not_configured");
  }
  const { auth, api, config } = input.runtime.runtime;

  try {
    const tokens = await auth.getAccessToken(new Secret(code));
    let shops;
    try {
      // Its own budget from now: the code is already spent, so a slow exchange must not starve this call.
      shops = await getAuthorizedShops(api, tokens.accessToken, { deadline: Date.now() + SHOPS_BUDGET_MS });
    } catch (error) {
      if (error instanceof TikTokApiError) return failed(apiErrorCode(error, "shops"), error);
      throw error;
    }
    if (shops.length === 0) return failed("no_shop");
    if (shops.length > 1) return failed("multiple_shops");
    const saved = await saveTikTokConnection(db, { tokens, shop: shops[0]!, staffUserId: session.staffUser.id, keyring: config.tokenKeyring, now });
    if (!saved.ok) return failed(saved.reason);
    // Optional token fields TikTok sent in an unusable shape (names only, T0): connected anyway, but
    // a surprise worth a warning.
    const dropped = tokens.droppedFields ?? [];
    if (dropped.length > 0) console.warn("[tiktok-connect] token fields dropped", { droppedFields: dropped });
    console.info("[tiktok-connect] connected", { shopId: shops[0]!.shopId, reconnected: saved.reconnected });
    return redirectTo(`${TIKTOK_INTEGRATION_PATH}?connected=${saved.reconnected ? "again" : "new"}`);
  } catch (error) {
    if (error instanceof TikTokApiError) return failed(apiErrorCode(error, "token"), error);
    // Anything else is a bug or a database failure: its name and driver code only (a driver
    // message can quote parameters, and parameters here are ciphertext), then a generic failure.
    console.error("[tiktok-connect] unexpected failure", errorLogFields(error));
    return failed("failed");
  }
}

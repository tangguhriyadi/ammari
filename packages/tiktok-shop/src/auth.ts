import "server-only";
import { z } from "zod";
import { RATE_LIMIT_CODE } from "./backoff";
import { TikTokApiError, DEFAULT_REQUEST_TIMEOUT_MS, type FetchLike } from "./client";
import { TIKTOK_AUTH_BASE_URL, TIKTOK_AUTH_ENDPOINTS, TIKTOK_AUTHORIZE_URL } from "./endpoints";
import { Secret } from "./secret";

// The auth host (docs/plans/tiktok-shop-integration.md §0 "Auth", §7.3): exchange an authorization
// code for tokens (`grant_type=authorized_code`, not `authorization_code`) and refresh them
// (`grant_type=refresh_token`). Both are GETs whose query carries the app secret, so the URL is
// never logged, and errors carry `{ kind, path, httpStatus, code, requestId }` only, like the API
// client. No retries here: the code works once (a retry after a lost answer could only fail), and a
// failed refresh is retried by the next cron run.
//
// Field names (`auth_code`, `app_secret`, `access_token_expire_in`, ...) follow TikTok's token
// documentation; the plan's confirmed facts (§0) name only the endpoints and grant types, so T0
// re-checks them on the development shop. `*_expire_in` are absolute Unix seconds; anything that
// does not look like a future instant is refused as `invalid_response`, never guessed.

const MAX_TOKEN_LIFETIME_S = 10 * 365 * 24 * 3600;

const envelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().optional(),
  request_id: z.string().optional(),
  data: z.unknown().optional(),
});

const tokenDataSchema = z.object({
  access_token: z.string().min(1).max(4096),
  access_token_expire_in: z.number().int(),
  refresh_token: z.string().min(1).max(4096),
  refresh_token_expire_in: z.number().int(),
  open_id: z.string().max(256).optional(),
  seller_name: z.string().max(512).optional(),
  seller_base_region: z.string().max(16).optional(),
  granted_scopes: z.array(z.string().max(128)).max(200).optional(),
});

export interface TikTokTokenSet {
  accessToken: Secret;
  accessTokenExpiresAt: Date;
  refreshToken: Secret;
  refreshTokenExpiresAt: Date;
  grantedScopes: string[];
  sellerName: string | null;
  sellerBaseRegion: string | null;
}

export interface TikTokAuthClientOptions {
  appKey: Secret;
  appSecret: Secret;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Epoch milliseconds. */
  now?: () => number;
  timeoutMs?: number;
}

export interface TikTokAuthClient {
  /** Exchanges the one-time authorization code from the OAuth callback. */
  getAccessToken(authCode: Secret): Promise<TikTokTokenSet>;
  refreshAccessToken(refreshToken: Secret): Promise<TikTokTokenSet>;
}

const SERVICE_ID_PATTERN = /^[0-9]{1,32}$/;

/** The authorize link (§7.3 step 1). `serviceId` is `TIKTOK_SERVICE_ID`, the Partner Center app ID
 * (decided Q4), never the App Key: the App Key is not even a parameter here. `state` is the raw
 * single-use state; the link is handed to the browser and never logged. */
export function buildAuthorizeUrl(input: { serviceId: string; state: Secret }): string {
  if (!SERVICE_ID_PATTERN.test(input.serviceId)) throw new Error("tiktok authorize url: service id must be the numeric Partner Center app ID");
  const search = new URLSearchParams({ service_id: input.serviceId, state: input.state.reveal() });
  return `${TIKTOK_AUTHORIZE_URL}?${search.toString()}`;
}

function httpsOrigin(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : null;
  if (!parsed || parsed.protocol !== "https:" || parsed.origin !== trimmed) throw new Error("tiktok auth client: baseUrl must be an https origin");
  return trimmed;
}

export function createTikTokAuthClient(options: TikTokAuthClientOptions): TikTokAuthClient {
  const baseUrl = httpsOrigin(options.baseUrl ?? TIKTOK_AUTH_BASE_URL);
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function call(path: string, params: Record<string, string>): Promise<TikTokTokenSet> {
    const search = new URLSearchParams({ app_key: options.appKey.reveal(), app_secret: options.appSecret.reveal(), ...params });
    const error = (kind: ConstructorParameters<typeof TikTokApiError>[0]["kind"], httpStatus: number | null, code: number | null, requestId: string | null) =>
      new TikTokApiError({ kind, path, httpStatus, code, requestId });

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}?${search.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      // Dropped on purpose: the message can quote the URL, whose query holds the app secret.
      throw error("network", null, null, null);
    }
    const httpStatus = response.status;
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw error("network", httpStatus, null, null);
    }
    let envelope: z.infer<typeof envelopeSchema> | null = null;
    try {
      const parsed = envelopeSchema.safeParse(JSON.parse(text));
      if (parsed.success) envelope = parsed.data;
    } catch {
      envelope = null;
    }
    const code = envelope?.code ?? null;
    const requestId = envelope?.request_id ?? null;
    if (httpStatus === 429 || code === RATE_LIMIT_CODE) throw error("rate_limited", httpStatus, code, requestId);
    if (httpStatus >= 500) throw error("unavailable", httpStatus, code, requestId);
    if (!envelope) throw error(httpStatus >= 200 && httpStatus < 300 ? "invalid_response" : "api", httpStatus, null, null);
    if (httpStatus < 200 || httpStatus >= 300 || envelope.code !== 0) throw error("api", httpStatus, code, requestId);

    const data = tokenDataSchema.safeParse(envelope.data);
    if (!data.success) throw error("invalid_response", httpStatus, code, requestId);
    const nowS = Math.floor(now() / 1000);
    const instant = (seconds: number): Date | null => (seconds > nowS && seconds <= nowS + MAX_TOKEN_LIFETIME_S ? new Date(seconds * 1000) : null);
    const accessTokenExpiresAt = instant(data.data.access_token_expire_in);
    const refreshTokenExpiresAt = instant(data.data.refresh_token_expire_in);
    if (!accessTokenExpiresAt || !refreshTokenExpiresAt) throw error("invalid_response", httpStatus, code, requestId);
    return {
      accessToken: new Secret(data.data.access_token),
      accessTokenExpiresAt,
      refreshToken: new Secret(data.data.refresh_token),
      refreshTokenExpiresAt,
      grantedScopes: [...new Set(data.data.granted_scopes ?? [])].sort(),
      sellerName: data.data.seller_name ?? null,
      sellerBaseRegion: data.data.seller_base_region ?? null,
    };
  }

  return {
    getAccessToken(authCode) {
      return call(TIKTOK_AUTH_ENDPOINTS.tokenGet, { auth_code: authCode.reveal(), grant_type: "authorized_code" });
    },
    refreshAccessToken(refreshToken) {
      return call(TIKTOK_AUTH_ENDPOINTS.tokenRefresh, { refresh_token: refreshToken.reveal(), grant_type: "refresh_token" });
    },
  };
}

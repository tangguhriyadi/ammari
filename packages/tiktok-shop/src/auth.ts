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
// documentation (authorization-overview-202407): `*_expire_in` are absolute Unix seconds.
//
// T0 (first real connect on dev, 28 Nov 2026): HTTP 200, code 0, refused as `invalid_response`
// with no way to tell which check failed. TikTok's docs say `refresh_token_expire_in` "equals the
// authorization duration the user granted", so it can lie far in the future (beyond the 10-year cap
// this file had). So now:
//   - required: both tokens (non-empty strings) and both expiries (integers). The access expiry
//     must be in the future and at most 30 days ahead (TikTok's default is 7); the refresh expiry
//     in the future and at most the end of the year 2200, stored as is (a timestamptz). Anything
//     below 1e9 is a relative lifetime, not an instant, and is refused, never guessed.
//   - optional (seller name and region, open_id, granted scopes): too long or the wrong type means
//     the field (or the one scope) is dropped and named in `droppedFields`, never a failed connect.
//     Unknown fields (`user_type`, ...) are ignored.
//   - every `invalid_response` carries a `detail` (see `TikTokApiError.detail`): which path failed
//     with zod's issue code, or which expiry, why and its year. Never a value.

const ACCESS_TOKEN_MAX_LIFETIME_S = 30 * 24 * 3600;
/** The last second of the year 2200 (UTC). */
const REFRESH_TOKEN_MAX_EXPIRY_S = Date.UTC(2201, 0, 1) / 1000 - 1;
/** Sept 2001: a smaller value is a lifetime in seconds, not an instant. */
const MIN_ABSOLUTE_S = 1_000_000_000;
const MAX_SCOPES = 200;
const MAX_DETAIL_ISSUES = 8;

const envelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().optional(),
  request_id: z.string().optional(),
  data: z.unknown().optional(),
});

const requiredTokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  access_token_expire_in: z.number().int(),
  refresh_token: z.string().min(1).max(4096),
  refresh_token_expire_in: z.number().int(),
});

export interface TikTokTokenSet {
  accessToken: Secret;
  accessTokenExpiresAt: Date;
  refreshToken: Secret;
  refreshTokenExpiresAt: Date;
  grantedScopes: string[];
  sellerName: string | null;
  sellerBaseRegion: string | null;
  /** Names of optional fields that were present but unusable (too long, wrong type) and dropped.
   * Field names only, safe to log. Absent on token sets not built by this client (test fakes). */
  droppedFields?: string[];
}

/** The only path segments a detail may name: our own schema keys, never a key TikTok sent. */
const DETAIL_KEYS: ReadonlySet<string> = new Set(Object.keys(requiredTokenSchema.shape));
const ISSUE_CODE = /^[a-z_]{1,32}$/;

/** `schema:<dotted path>:<issue code>` per failing path. Path segments are allowlisted to the schema
 * keys and the code to zod's fixed snake_case set; anything else is masked as `?`. Never a message
 * (zod's can quote the value). */
function schemaDetail(issues: readonly z.core.$ZodIssue[]): string {
  const parts = new Set<string>();
  for (const issue of issues) {
    const path = issue.path.length === 0 ? "(root)" : issue.path.map((segment) => (typeof segment === "string" && DETAIL_KEYS.has(segment) ? segment : "?")).join(".");
    const code = ISSUE_CODE.test(issue.code) ? issue.code : "?";
    parts.add(`schema:${path}:${code}`);
    if (parts.size >= MAX_DETAIL_ISSUES) break;
  }
  return [...parts].join(";");
}

/** The year only (never the full number), or `out_of_range` past what a Date holds. */
function expiryYear(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "out_of_range" : String(date.getUTCFullYear());
}

function checkExpiry(which: "access" | "refresh", seconds: number, nowS: number, maxS: number): { at: Date } | { detail: string } {
  const reason = seconds < MIN_ABSOLUTE_S ? "relative" : seconds <= nowS ? "past" : seconds > maxS ? "beyond_cap" : null;
  if (reason) return { detail: `expiry:${which}:${reason}:${expiryYear(seconds)}` };
  return { at: new Date(seconds * 1000) };
}

/** Optional fields: absent, null or empty is "none"; too long or the wrong type is dropped. */
function readOptional(raw: Record<string, unknown>, dropped: Set<string>): Pick<TikTokTokenSet, "sellerName" | "sellerBaseRegion" | "grantedScopes"> {
  const text = (key: string, max: number): string | null => {
    const value = raw[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string" && value.length <= max) return value;
    dropped.add(key);
    return null;
  };
  text("open_id", 256); // validated only: nothing stores it
  const sellerName = text("seller_name", 512);
  const sellerBaseRegion = text("seller_base_region", 16);

  let grantedScopes: string[] = [];
  const scopes = raw.granted_scopes;
  if (Array.isArray(scopes)) {
    const valid = scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0 && scope.length <= 128);
    const unique = [...new Set(valid)];
    if (valid.length !== scopes.length || unique.length > MAX_SCOPES) dropped.add("granted_scopes");
    grantedScopes = unique.slice(0, MAX_SCOPES).sort();
  } else if (scopes !== undefined && scopes !== null) {
    dropped.add("granted_scopes");
  }
  return { sellerName, sellerBaseRegion, grantedScopes };
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
    const error = (kind: ConstructorParameters<typeof TikTokApiError>[0]["kind"], httpStatus: number | null, code: number | null, requestId: string | null, detail: string | null = null) =>
      new TikTokApiError({ kind, path, httpStatus, code, requestId, detail });

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
    if (!envelope) {
      if (httpStatus >= 200 && httpStatus < 300) throw error("invalid_response", httpStatus, null, null, "envelope_unparsable");
      throw error("api", httpStatus, null, null);
    }
    if (httpStatus < 200 || httpStatus >= 300 || envelope.code !== 0) throw error("api", httpStatus, code, requestId);

    const required = requiredTokenSchema.safeParse(envelope.data);
    if (!required.success) throw error("invalid_response", httpStatus, code, requestId, schemaDetail(required.error.issues));
    const nowS = Math.floor(now() / 1000);
    // The access expiry first: when both are wrong, the first one named is the one to look at.
    const access = checkExpiry("access", required.data.access_token_expire_in, nowS, nowS + ACCESS_TOKEN_MAX_LIFETIME_S);
    if ("detail" in access) throw error("invalid_response", httpStatus, code, requestId, access.detail);
    const refresh = checkExpiry("refresh", required.data.refresh_token_expire_in, nowS, REFRESH_TOKEN_MAX_EXPIRY_S);
    if ("detail" in refresh) throw error("invalid_response", httpStatus, code, requestId, refresh.detail);

    // `envelope.data` passed `z.object` (non-null, not an array) and came from JSON.parse.
    const dropped = new Set<string>();
    const optional = readOptional(envelope.data as Record<string, unknown>, dropped);
    return {
      accessToken: new Secret(required.data.access_token),
      accessTokenExpiresAt: access.at,
      refreshToken: new Secret(required.data.refresh_token),
      refreshTokenExpiresAt: refresh.at,
      ...optional,
      droppedFields: [...dropped].sort(),
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

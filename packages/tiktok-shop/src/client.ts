import "server-only";
import { z } from "zod";
import {
  MAX_RATE_LIMIT_TRIES,
  RATE_LIMIT_CODE,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MIN_DELAY_MS,
  SHORT_RETRY_DELAYS_MS,
  parseRetryAfterMs,
  rateLimitDelayMs,
} from "./backoff";
import { TIKTOK_API_BASE_URL } from "./endpoints";
import { Secret } from "./secret";
import { signRequest } from "./sign";

// Signed TikTok Shop Open API client (docs/plans/tiktok-shop-integration.md §0 "API", §8.2).
// Pure apart from the injected `fetch`; no database, no logging. Errors carry
// `{ kind, path, httpStatus, code, requestId }` only: never the URL (its query holds `sign` and
// `app_key`), a header, a token or a response body.
//
// Retries (§8.2):
//   - HTTP 429 or envelope code 36009002 → rate limit: `Retry-After` if present, else exponential
//     1-60 s with full jitter; at most 5 tries, then `rate_limited`.
//   - 503 and every other 5xx are NOT rate limits: 2 short retries (1 s, 3 s), then `unavailable`.
//   - Network errors and the 10-s timeout: 2 short retries, then `network`.
//   - An auth error: one `onAuthError` refresh + one retry, then `reauth_required`
//     (`refresh_failed` when the refresher itself failed for another reason).
//   - A `Retry-After` above 60 s is not waited out inside one request: `rate_limited` at once, and
//     the next run retries. Below 1 s it is raised to 1 s.
//   - Any other non-zero code: `api`, no retry.
// Phase 1 is read-only towards TikTok (decided Q15) apart from Update Inventory (stock sync S2,
// ./inventory.ts), which sets absolute quantities; so every call here is safe to repeat.

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type TikTokErrorKind =
  /** Still rate limited after 5 tries, or `Retry-After` longer than 60 s / the time budget. */
  | "rate_limited"
  /** 5xx after the short retries. */
  | "unavailable"
  /** Network failure or timeout after the short retries. */
  | "network"
  /** Auth error, and the one refresh + retry did not fix it (or no refresher was given). */
  | "reauth_required"
  /** A code the caller declared as "timestamp out of window"; logged as `clock_skew`. */
  | "clock_skew"
  /** Any other non-zero code or non-retryable HTTP status. */
  | "api"
  /** Not the documented envelope, or `data` failed the caller's schema. */
  | "invalid_response"
  /** `onAuthError` failed for a reason other than an invalid refresh token (a database blip, a
   * lock timeout): the connection is not known to be broken, so this is not `reauth_required`. */
  | "refresh_failed"
  /** The run's time budget is spent; no new request was started. */
  | "budget_exhausted";

export type TikTokErrorFields = { kind: TikTokErrorKind; path: string; httpStatus: number | null; code: number | null; requestId: string | null };

export class TikTokApiError extends Error {
  readonly kind: TikTokErrorKind;
  readonly path: string;
  readonly httpStatus: number | null;
  readonly code: number | null;
  readonly requestId: string | null;
  /** Why a response was refused, for the log (the auth host's `invalid_response`, T0): built only
   * from field paths, issue codes and an expiry's year, never from a value TikTok sent. */
  readonly detail: string | null;

  constructor(fields: TikTokErrorFields & { detail?: string | null }) {
    super(`tiktok ${fields.kind}: ${fields.path} (http ${fields.httpStatus ?? "-"}, code ${fields.code ?? "-"}, request ${fields.requestId ?? "-"})`);
    this.name = "TikTokApiError";
    this.kind = fields.kind;
    this.path = fields.path;
    this.httpStatus = fields.httpStatus;
    this.code = fields.code;
    this.requestId = fields.requestId;
    this.detail = fields.detail ?? null;
  }

  /** The loggable fields, nothing else. */
  toJSON(): TikTokErrorFields & { detail?: string } {
    const fields: TikTokErrorFields = { kind: this.kind, path: this.path, httpStatus: this.httpStatus, code: this.code, requestId: this.requestId };
    return this.detail === null ? fields : { ...fields, detail: this.detail };
  }
}

const envelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().optional(),
  request_id: z.string().optional(),
  data: z.unknown().optional(),
});

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TikTokClientOptions {
  appKey: Secret;
  appSecret: Secret;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Epoch milliseconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1); the jitter source. */
  random?: () => number;
  timeoutMs?: number;
  /** Envelope codes that mean "access token invalid or expired" (HTTP 401 always does). TikTok's
   * exact codes are not in the plan's confirmed facts (§0), so they are passed in, not guessed. */
  authErrorCodes?: ReadonlySet<number>;
  /** Envelope codes that mean "timestamp outside the 5-minute window". Same reason. */
  clockSkewCodes?: ReadonlySet<number>;
}

export interface TikTokRequest<T> {
  method: "GET" | "POST";
  /** A path from ./endpoints.ts. */
  path: string;
  /** Extra query parameters (`app_key`, `timestamp`, `sign`, `shop_cipher`, `access_token` are
   * set by the client). Values are signed raw and URL-encoded only in the URL (`page_token`). */
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON-serialized once; that exact string is signed and sent. */
  body?: unknown;
  accessToken?: Secret;
  shopCipher?: string;
  /** Validates `data`. A mismatch is `invalid_response`. */
  schema: z.ZodType<T>;
  /** Called once on an auth error; returns a fresh token (the T2 refresh, under its own lock). To
   * say the refresh token itself is no longer valid, throw a `TikTokApiError` of kind
   * `reauth_required`; any `TikTokApiError` is passed through unchanged, and any other error
   * becomes `refresh_failed`. */
  onAuthError?: () => Promise<Secret>;
  /** Epoch ms after which no new attempt (or wait) is started (the run's time budget, §8.2). Every
   * sync caller must pass one: without it only the per-kind retry caps bound the call. */
  deadline?: number;
}

// Paths come from ./endpoints.ts; ids inside them are percent-encoded. No `..`, `?`, `#` or space.
const PATH_PATTERN = /^\/[A-Za-z0-9_%.\-]+(?:\/[A-Za-z0-9_%.\-]+)*$/;

const CLIENT_OWNED_PARAMS = new Set(["app_key", "timestamp", "sign", "shop_cipher", "access_token"]);

type Attempt<T> =
  | { kind: "ok"; data: T }
  | { kind: "rate_limited"; httpStatus: number; code: number | null; requestId: string | null; retryAfterMs: number | null }
  | { kind: "unavailable"; httpStatus: number; code: number | null; requestId: string | null }
  | { kind: "network" }
  | { kind: "auth"; httpStatus: number; code: number | null; requestId: string | null }
  | { kind: "fail"; error: TikTokApiError };

export interface TikTokClient {
  request<T>(request: TikTokRequest<T>): Promise<T>;
}

export function createTikTokClient(options: TikTokClientOptions): TikTokClient {
  const baseUrl = (options.baseUrl ?? TIKTOK_API_BASE_URL).replace(/\/+$/, "");
  // The app key, the sign and the access token go to this host: https only, no path or query.
  const parsedBase = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
  if (!parsedBase || parsedBase.protocol !== "https:" || parsedBase.origin !== baseUrl) {
    throw new Error("tiktok client: baseUrl must be an https origin");
  }
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const authErrorCodes = options.authErrorCodes ?? new Set<number>();
  const clockSkewCodes = options.clockSkewCodes ?? new Set<number>();

  async function attempt<T>(request: TikTokRequest<T>, bodyText: string | undefined, accessToken: Secret | undefined): Promise<Attempt<T>> {
    // Never run past the time budget: the per-request timeout is clamped to what is left of it.
    const attemptTimeoutMs = request.deadline === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, request.deadline - now()));
    const { path } = request;
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) query[key] = String(value);
    }
    query.app_key = options.appKey.reveal();
    query.timestamp = String(Math.floor(now() / 1000));
    if (request.shopCipher !== undefined) query.shop_cipher = request.shopCipher;
    const sign = signRequest({ appSecret: options.appSecret.reveal(), path, query, body: bodyText });
    // URLSearchParams percent-encodes every reserved character, so a `page_token` holding `+`, `/`
    // or `=` arrives intact (a literal `+` would otherwise decode as a space).
    const search = new URLSearchParams({ ...query, sign });
    const headers: Record<string, string> = { accept: "application/json" };
    if (bodyText !== undefined) headers["content-type"] = "application/json";
    if (accessToken) headers["x-tts-access-token"] = accessToken.reveal();

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}?${search.toString()}`, {
        method: request.method,
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(attemptTimeoutMs),
        redirect: "error",
      });
    } catch {
      // Network failure, DNS, TLS, timeout or abort. The error itself is dropped: undici's message
      // can quote the URL, and the URL carries `sign` and `app_key`.
      return { kind: "network" };
    }

    const httpStatus = response.status;
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { kind: "network" };
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
    const fail = (kind: TikTokErrorKind): Attempt<T> => ({ kind: "fail", error: new TikTokApiError({ kind, path, httpStatus, code, requestId }) });

    if (httpStatus === 429 || code === RATE_LIMIT_CODE) {
      return { kind: "rate_limited", httpStatus, code, requestId, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"), now()) };
    }
    if (httpStatus >= 500) return { kind: "unavailable", httpStatus, code, requestId };
    if (httpStatus === 401 || (code !== null && authErrorCodes.has(code))) return { kind: "auth", httpStatus, code, requestId };
    if (code !== null && clockSkewCodes.has(code)) return fail("clock_skew");
    if (!envelope) return fail(httpStatus >= 200 && httpStatus < 300 ? "invalid_response" : "api");
    if (httpStatus < 200 || httpStatus >= 300 || envelope.code !== 0) return fail("api");
    const data = request.schema.safeParse(envelope.data);
    if (!data.success) return fail("invalid_response");
    return { kind: "ok", data: data.data };
  }

  return {
    async request<T>(request: TikTokRequest<T>): Promise<T> {
      const { path, deadline } = request;
      if (!PATH_PATTERN.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) {
        throw new Error("tiktok client: invalid path");
      }
      for (const key of Object.keys(request.query ?? {})) {
        if (CLIENT_OWNED_PARAMS.has(key)) throw new Error(`tiktok client: query parameter ${key} is set by the client`);
      }
      const bodyText = request.body === undefined ? undefined : JSON.stringify(request.body);
      const budgetError = (last?: { httpStatus: number | null; code: number | null; requestId: string | null }) =>
        new TikTokApiError({ kind: "budget_exhausted", path, httpStatus: last?.httpStatus ?? null, code: last?.code ?? null, requestId: last?.requestId ?? null });
      const withinBudget = (waitMs = 0) => deadline === undefined || now() + waitMs < deadline;

      let accessToken = request.accessToken;
      let rateLimitedTries = 0;
      let unavailableRetries = 0;
      let networkRetries = 0;
      let refreshed = false;

      for (;;) {
        if (!withinBudget()) throw budgetError();
        const result = await attempt(request, bodyText, accessToken);
        switch (result.kind) {
          case "ok":
            return result.data;
          case "fail":
            throw result.error;
          case "rate_limited": {
            rateLimitedTries += 1;
            const error = new TikTokApiError({ kind: "rate_limited", path, httpStatus: result.httpStatus, code: result.code, requestId: result.requestId });
            if (rateLimitedTries >= MAX_RATE_LIMIT_TRIES) throw error;
            // Retry-After is honoured, but never below the 1-s floor (a `0` or a past date would
            // otherwise fire the remaining tries back to back).
            const waitMs = Math.max(RATE_LIMIT_MIN_DELAY_MS, result.retryAfterMs ?? rateLimitDelayMs(rateLimitedTries, random));
            // Never retry before `Retry-After`; if that is beyond what one request may wait, give
            // up now and let the next run try.
            if (waitMs > RATE_LIMIT_MAX_DELAY_MS || !withinBudget(waitMs)) throw error;
            await sleep(waitMs);
            break;
          }
          case "unavailable": {
            const waitMs = SHORT_RETRY_DELAYS_MS[unavailableRetries];
            const error = new TikTokApiError({ kind: "unavailable", path, httpStatus: result.httpStatus, code: result.code, requestId: result.requestId });
            if (waitMs === undefined || !withinBudget(waitMs)) throw error;
            unavailableRetries += 1;
            await sleep(waitMs);
            break;
          }
          case "network": {
            const waitMs = SHORT_RETRY_DELAYS_MS[networkRetries];
            const error = new TikTokApiError({ kind: "network", path, httpStatus: null, code: null, requestId: null });
            if (waitMs === undefined || !withinBudget(waitMs)) throw error;
            networkRetries += 1;
            await sleep(waitMs);
            break;
          }
          case "auth": {
            const error = new TikTokApiError({ kind: "reauth_required", path, httpStatus: result.httpStatus, code: result.code, requestId: result.requestId });
            if (refreshed || !request.onAuthError) throw error;
            refreshed = true;
            try {
              accessToken = await request.onAuthError();
            } catch (refreshError) {
              if (refreshError instanceof TikTokApiError) throw refreshError;
              // The refresher's own error is dropped (it may quote a token or a URL).
              throw new TikTokApiError({ kind: "refresh_failed", path, httpStatus: result.httpStatus, code: result.code, requestId: result.requestId });
            }
            break;
          }
        }
      }
    },
  };
}

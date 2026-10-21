import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// Authentication for the internal cron routes (`/api/internal/*`, docs/plans/cart-checkout.md
// §6.3, §11): called only by the cron service on the servers' internal Docker network
// (deploy/cron/cron.sh, deploy-prod/cron/cron.sh), straight at the web container, never through
// Caddy (which answers 404 for `/api/internal/*` on every public host). Three checks:
// 1. INTERNAL_CRON_SECRET must be configured (at least 32 characters); otherwise every call is
//    refused with 503 and the problem logged once per process (name only, never a value).
// 2. A request that came through a proxy (`CF-Connecting-IP` or `X-Forwarded-For` present) is
//    refused as not found: the cron service calls the container directly, so such a request
//    means the path is reachable from outside, which it must never be.
// 3. `Authorization: Bearer <INTERNAL_CRON_SECRET>`, compared in constant time (as SHA-256
//    digests, so the lengths always match).

export const INTERNAL_CRON_SECRET_MIN_LENGTH = 32;

export type CronAuth = { ok: true } | { ok: false; response: Response };

let loggedMissingSecret = false;

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function authorizeCronRequest(request: Request, job: string): CronAuth {
  const secret = process.env.INTERNAL_CRON_SECRET?.trim() ?? "";
  if (secret.length < INTERNAL_CRON_SECRET_MIN_LENGTH) {
    if (!loggedMissingSecret) {
      console.error("[cron] INTERNAL_CRON_SECRET is not set (or shorter than 32 characters); internal cron routes refuse every call", { job });
      loggedMissingSecret = true;
    }
    return { ok: false, response: plain(503, "not configured") };
  }
  loggedMissingSecret = false;

  if (request.headers.has("cf-connecting-ip") || request.headers.has("x-forwarded-for")) {
    console.error("[cron] internal cron route reached through a proxy; refused", { job });
    return { ok: false, response: plain(404, "not found") };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1] || !timingSafeEqual(digest(match[1]), digest(secret))) {
    console.warn("[cron] internal cron route called without the right secret; refused", { job, hadAuthorization: header.length > 0 });
    return { ok: false, response: plain(401, "unauthorized") };
  }
  return { ok: true };
}

export function cronJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
}

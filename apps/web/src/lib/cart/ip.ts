import "server-only";
import { headers } from "next/headers";
import { rateLimitBucketForIp } from "./ip-bucket";

/** The client address for the cart's and checkout's per-IP limits (cart writes, area search):
 * `CF-Connecting-IP` (never X-Forwarded-For, see lib/claim/ip.ts and SPEC §11: the origin only
 * accepts traffic through Cloudflare).
 *
 * Unlike the claim reader, a missing or malformed header never falls back to one shared bucket:
 * every stepper tap is a cart write, so a shared bucket would take the cart down for everyone.
 * In production that case means the proxy setup is broken: logged loudly and refused (`null`).
 * Locally (no Cloudflare) every request counts as 127.0.0.1. `purpose` only names the refused
 * request in the log. An IPv6 address is returned as its /64 network (`rateLimitBucketForIp`), the
 * unit one client actually controls; callers only ever use this value as a rate-limit key. */
export async function getCartClientIp(purpose = "cart write"): Promise<string | null> {
  const value = (await headers()).get("cf-connecting-ip")?.trim();
  const bucket = value ? rateLimitBucketForIp(value) : null;
  if (bucket) return bucket;
  if (process.env.NODE_ENV !== "production") return "127.0.0.1";
  console.error(`[cart] missing or invalid CF-Connecting-IP header; refusing ${purpose}`);
  return null;
}

import "server-only";
import { isIP } from "node:net";
import { headers } from "next/headers";

/** The client address for the cart's per-IP limits: `CF-Connecting-IP` (never X-Forwarded-For,
 * see lib/claim/ip.ts and SPEC §11: the origin only accepts traffic through Cloudflare).
 *
 * Unlike the claim reader, a missing or malformed header never falls back to one shared bucket:
 * every stepper tap is a cart write, so a shared bucket would take the cart down for everyone.
 * In production that case means the proxy setup is broken: logged loudly and refused (`null`).
 * Locally (no Cloudflare) every request counts as 127.0.0.1. */
export async function getCartClientIp(): Promise<string | null> {
  const value = (await headers()).get("cf-connecting-ip")?.trim();
  if (value && isIP(value) !== 0) return value;
  if (process.env.NODE_ENV !== "production") return "127.0.0.1";
  console.error("[cart] missing or invalid CF-Connecting-IP header; refusing cart write");
  return null;
}

import "server-only";
import { headers } from "next/headers";

/** Same header both Better Auth instances key their own per-IP limiters off of
 * (`ipAddressHeaders: ["cf-connecting-ip"]` in packages/auth) — never `X-Forwarded-For`, which a
 * client can set itself on a direct-to-origin request. Relies on the same pre-deploy
 * requirement (docs/SPEC.md §11) that the origin only ever accepts traffic that actually came
 * through Cloudflare; this endpoint isn't Better Auth-backed, so it needs its own reader rather
 * than inheriting one from the auth instance. */
export async function getClaimClientIp(): Promise<string> {
  const h = await headers();
  return h.get("cf-connecting-ip") ?? "0.0.0.0";
}

/** Pure, unit-testable gate for app/api/test/login/route.ts. Four independent fail-closed
 * conditions must ALL hold before the e2e sign-in backdoor does anything:
 *   1. NODE_ENV is never "production" (Next sets this at build/start — not overridable by a
 *      stray env var in a real deploy).
 *   2. E2E_TEST_LOGIN must be explicitly "true" (never set in the deployed dev environment,
 *      only in local/CI Playwright runs).
 *   3. The email must end in "@e2e.ammari.test" — this route can never be used to sign in as a
 *      real staff account, whose emails never use that suffix.
 *   4. The request must *look* like it came from localhost — both the Host header and (when
 *      present) the first x-forwarded-for hop must resolve to a loopback address.
 *
 * Condition 4's caveat: `Host` and `x-forwarded-for` are ordinary request headers, so on their
 * own they only block a casual/accidental hit, not a client that deliberately spoofs them —
 * same category of header as CLAUDE.md's note on `CF-Connecting-IP` needing Cloudflare in front
 * to be trustworthy. The real enforcement for this condition is at the network layer: the e2e
 * Playwright run starts the dev server bound to 127.0.0.1 only (`pnpm dev:e2e`, see
 * playwright.config.ts), so nothing outside the machine can open a TCP connection to it in the
 * first place, regardless of what headers it would send. Conditions 1–3 are the gate's real,
 * un-spoofable backbone; condition 4 is defense-in-depth on top of that network boundary, not a
 * substitute for it — don't reuse this route's config against a server reachable from a network
 * without an equivalent bind/firewall restriction.
 */

const ALLOWED_EMAIL_SUFFIX = "@e2e.ammari.test";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export interface E2eLoginGateInput {
  nodeEnv: string | undefined;
  e2eTestLoginFlag: string | undefined;
  email: string;
  /** The request's `Host` header, e.g. "localhost:3001" or "[::1]:3001". */
  host: string | null;
  /** The request's `x-forwarded-for` header, if any. */
  forwardedFor: string | null;
}

/** Strips a trailing ":<port>" from a Host header value, without mangling a bracketed IPv6
 * literal (`"[::1]:3001"` -> `"::1"`, not `"["`). */
function hostnameOf(host: string | null): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0] ?? "";
}

export function isE2eLoginRequestAllowed(input: E2eLoginGateInput): boolean {
  if (input.nodeEnv === "production") return false;
  if (input.e2eTestLoginFlag !== "true") return false;
  if (!input.email.toLowerCase().endsWith(ALLOWED_EMAIL_SUFFIX)) return false;

  if (!LOOPBACK_HOSTNAMES.has(hostnameOf(input.host))) return false;

  if (input.forwardedFor) {
    const clientIp = input.forwardedFor.split(",")[0]?.trim() ?? "";
    if (!LOOPBACK_HOSTNAMES.has(clientIp)) return false;
  }

  return true;
}

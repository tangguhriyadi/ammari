/** Pure, unit-testable gate for app/api/test/otp/route.ts — the main site's own copy of
 * apps/admin's identical e2e-login-gate.ts (duplicated rather than shared: this is plain
 * application code with no cross-package import obstacle, but each app owning its own copy
 * matches this repo's existing convention for small, security-sensitive e2e-only gates — see
 * apps/admin/playwright.config.ts's own `e2eDatabaseUrl` for the same "kept in sync rather than
 * imported" posture, applied here for a different reason: clarity that each app's backdoor is
 * independently gated, not a shared trust boundary). Four independent fail-closed conditions
 * must ALL hold:
 *   1. NODE_ENV is never "production".
 *   2. E2E_TEST_LOGIN must be explicitly "true".
 *   3. The email must end in "@e2e.ammari.test" — this route can never read back an OTP for a
 *      real customer's email.
 *   4. The request must *look* like it came from localhost — see apps/admin's own copy of this
 *      file for the full reasoning on why this condition is defense-in-depth on top of the
 *      e2e dev server's own loopback-only bind (`dev:e2e`), not a substitute for it.
 */

const ALLOWED_EMAIL_SUFFIX = "@e2e.ammari.test";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export interface E2eLoginGateInput {
  nodeEnv: string | undefined;
  e2eTestLoginFlag: string | undefined;
  email: string;
  /** The request's `Host` header, e.g. "localhost:3000" or "[::1]:3000". */
  host: string | null;
  /** The request's `x-forwarded-for` header, if any. */
  forwardedFor: string | null;
}

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

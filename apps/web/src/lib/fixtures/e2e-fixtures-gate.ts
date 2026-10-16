// Pure, unit-testable gate for app/api/test/fixtures/[...path]/route.ts — same shape and
// reasoning as ../preview/e2e-gate.ts (reused flag name, E2E_TEST_LOGIN, for the same "test
// backdoors enabled" umbrella concept). Three independent fail-closed conditions must ALL hold
// before this route serves a fixture image instead of 404ing:
//   1. NODE_ENV is never "production" (see ../preview/e2e-gate.ts's own comment on why this is
//      an env-file-overridable belt, not a structural guarantee, in the deployed container).
//   2. E2E_TEST_LOGIN must be explicitly "true" (never set in the deployed dev environment).
//   3. The request must look like it came from localhost (Host header) — see
//      ../preview/e2e-gate.ts for the two different things backing this up locally vs against
//      the deployed container. deploy/Caddyfile's /api/test/* block covers this route too,
//      regardless of Host header games.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export interface E2eFixturesGateInput {
  nodeEnv: string | undefined;
  e2eTestLoginFlag: string | undefined;
  host: string | null;
}

function hostnameOf(host: string | null): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0] ?? "";
}

export function isE2eFixturesRequestAllowed(input: E2eFixturesGateInput): boolean {
  if (input.nodeEnv === "production") return false;
  if (input.e2eTestLoginFlag !== "true") return false;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(input.host));
}

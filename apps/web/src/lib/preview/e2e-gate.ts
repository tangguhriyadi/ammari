// Pure, unit-testable gate for app/api/test/preview-token/route.ts — same shape and reasoning as
// apps/admin's lib/auth/e2e-login-gate.ts (reused flag name, E2E_TEST_LOGIN, for the same "test
// backdoors enabled" umbrella concept). Three independent fail-closed conditions must ALL hold
// before this route mints a token for the e2e suite instead of a real preview flow:
//   1. NODE_ENV is never "production" — the deployed image bakes `ENV NODE_ENV=production` into
//      the Dockerfile's runtime stage, but that IS overridable by a runtime env_file entry
//      (deploy/docker-compose.yml's `env_file: ./env/web.env`) — confirmed empirically, this is
//      standard Docker behavior. Never set there today, but that's a matter of nobody having
//      typed it, not a structural guarantee.
//   2. E2E_TEST_LOGIN must be explicitly "true" (never set in the deployed dev environment).
//   3. The request must *look* like it came from localhost (Host header). Two DIFFERENT things
//      back this up depending on where the request originates, neither of which this gate can
//      tell apart on its own: locally, `pnpm --filter @ammari/web dev:e2e` binds to 127.0.0.1
//      only, so nothing outside the machine can even open a TCP connection in the first place.
//      Against the DEPLOYED container (which binds 0.0.0.0, not loopback — see Dockerfile's own
//      HOSTNAME comment), this condition instead relies on Caddy passing the client's real Host
//      header through unmodified (its documented reverse_proxy default — no header_up override
//      in deploy/Caddyfile) — a public request would carry Host: ammari.my.id, which fails this
//      check. That's a real but weaker backstop than the local bind, which is exactly why
//      deploy/Caddyfile ALSO blocks /api/test/* outright for the public hostname: it holds
//      regardless of Host header games or whether conditions 1/2 above were ever defeated.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export interface E2ePreviewTokenGateInput {
  nodeEnv: string | undefined;
  e2eTestLoginFlag: string | undefined;
  host: string | null;
}

function hostnameOf(host: string | null): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0] ?? "";
}

export function isE2ePreviewTokenRequestAllowed(input: E2ePreviewTokenGateInput): boolean {
  if (input.nodeEnv === "production") return false;
  if (input.e2eTestLoginFlag !== "true") return false;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(input.host));
}

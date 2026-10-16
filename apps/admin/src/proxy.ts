import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { staffAuth } from "@/lib/auth/staff";

// Next.js 16 renamed `middleware.ts` to `proxy.ts` and defaults it to the Node.js runtime, which
// is what makes a real, database-backed session check (not just an optimistic cookie decode)
// possible here — see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
//
// This is a COARSE gate only: "is there any valid staff session at all". It intentionally does
// NOT check permissions — that's requirePermission()'s job in every page/action/route handler.
// Per Next's own data-security guide, Server Functions aren't separate routes in this matcher
// chain, so this can never be the only authorization boundary.
const PUBLIC_PATHS = ["/login"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // "/api/test" is the e2e-only sign-in backdoor (app/api/test/login/route.ts) — proxy merely
  // lets the request reach the handler; the real fail-closed gate (NODE_ENV, an explicit opt-in
  // flag, an @e2e.ammari.test email suffix, and a localhost-only check) lives there, not here.
  // "/api/health" (docs/deploy.md) must stay reachable with no session — Docker Compose's own
  // healthcheck and the deploy script's post-restart poll both call it unauthenticated.
  // "/logos" (public/logos/*, e.g. the Google sign-in "G") must stay reachable with no session
  // too — the matcher below only exempts `_next/static`/`_next/image`/favicon.ico, so without
  // this an `<img src="/logos/...">` on the unauthenticated /login page itself would 307-redirect
  // to /login, rendering as a broken image (confirmed by curling it directly). Static brand
  // assets only — never a path an authorization decision should hang on.
  if (
    PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/test") ||
    pathname === "/api/health" ||
    pathname.startsWith("/logos/")
  ) {
    return NextResponse.next();
  }

  const session = await staffAuth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import { NextResponse, type NextRequest } from "next/server";
import { xRobotsTagFor } from "@/lib/seo/indexing";

// Headers only: this never redirects, rewrites or checks a session. The "no proxy.ts" decision
// (docs/plans/voucher-claim.md #3) is about session gating, which still lives in each page and
// action. This exists because `X-Robots-Tag` has to follow the RUNTIME DEPLOY_ENV, and
// next.config.ts `headers()` is fixed at `next build` in an environment-neutral image
// (docs/plans/seo.md §2). Off production every response gets noindex (non-HTML too, which a meta
// tag cannot cover); on production only the private paths do.
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const value = xRobotsTagFor(request.nextUrl.pathname, process.env.DEPLOY_ENV);
  if (value) response.headers.set("X-Robots-Tag", value);
  return response;
}

export const config = {
  // Build output (hashed JS/CSS) is never a search result; everything else, public/ included.
  matcher: ["/((?!_next/static|_next/image).*)"],
};

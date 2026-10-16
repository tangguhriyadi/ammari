import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { generateHomepagePreviewToken } from "@/lib/preview/token";
import { isE2ePreviewTokenRequestAllowed } from "@/lib/preview/e2e-gate";

// e2e-only backdoor, mirroring apps/admin's app/api/test/login/route.ts — mints a real preview
// token (through the real signing code) without going through apps/admin's "Pratinjau" action,
// and optionally backdates it via `ttlSeconds` so the e2e suite can exercise the
// already-expired-token rejection path. See e2e-gate.ts for the three fail-closed conditions.
function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const allowed = isE2ePreviewTokenRequestAllowed({
    nodeEnv: process.env.NODE_ENV,
    e2eTestLoginFlag: process.env.E2E_TEST_LOGIN,
    host: request.headers.get("host"),
  });
  if (!allowed) return notFound();

  const body: unknown = await request.json().catch(() => ({}));
  const ttlSecondsRaw = (body as { ttlSeconds?: unknown } | null)?.ttlSeconds;
  const ttlSeconds = typeof ttlSecondsRaw === "number" ? ttlSecondsRaw : undefined;

  const token = generateHomepagePreviewToken(ttlSeconds !== undefined ? { ttlSeconds } : {});
  return NextResponse.json({ token });
}

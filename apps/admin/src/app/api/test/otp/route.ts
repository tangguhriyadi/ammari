import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { capturingEmailSender } from "@/lib/auth/staff";
import { isE2eLoginRequestAllowed } from "@/lib/auth/e2e-login-gate";

// e2e-only — lets a test read back the OTP a REAL `/login` form submission just triggered
// (through the real `staffAuth` instance, real throttle/rate-limit code paths, real HTTP
// endpoint), unlike app/api/test/login/route.ts's instant-sign-in backdoor, which never drives
// that UI at all. Same four independent fail-closed conditions as that route (see
// e2e-login-gate.ts): non-production, E2E_TEST_LOGIN=true, an @e2e.ammari.test email, and a
// loopback-looking request — plus the same Caddy `/api/test/*` edge block
// (deploy/Caddyfile) covering this path too.
function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const email = typeof (body as { email?: unknown } | null)?.email === "string" ? (body as { email: string }).email : null;
  if (!email) return notFound();

  const allowed = isE2eLoginRequestAllowed({
    nodeEnv: process.env.NODE_ENV,
    e2eTestLoginFlag: process.env.E2E_TEST_LOGIN,
    email,
    host: request.headers.get("host"),
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  if (!allowed || !capturingEmailSender) return notFound();

  const otp = capturingEmailSender.takeOtp(email);
  if (!otp) {
    // Not a gate failure — the gate already passed. The real send either hasn't happened yet,
    // was itself throttled, or targeted an email this fixture didn't actually send for.
    return NextResponse.json({ error: "otp_not_captured" }, { status: 422 });
  }

  return NextResponse.json({ otp });
}

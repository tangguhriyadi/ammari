import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { e2eSignInAuth, capturingEmailSender } from "@/lib/auth/staff";
import { isE2eLoginRequestAllowed } from "@/lib/auth/e2e-login-gate";

// e2e-only sign-in backdoor — see docs/SPEC.md's plan notes and e2e-login-gate.ts for the four
// independent fail-closed conditions this requires. Exercises the REAL Better Auth code path
// (hooks, rate limiting, cookie issuance via nextCookies()) and only skips reading the OTP from
// an actual email inbox — nothing about staff sign-in is reimplemented here.
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
  if (!allowed || !capturingEmailSender || !e2eSignInAuth) return notFound();

  await e2eSignInAuth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const otp = capturingEmailSender.takeOtp(email);
  if (!otp) {
    // Not a security-gate failure — the gate already passed. This means the email isn't a
    // seeded staff fixture, or the throttle/rate limiter blocked the send; either way the e2e
    // test's own setup is wrong, so fail loudly rather than returning the generic 404.
    return NextResponse.json({ error: "otp_not_captured" }, { status: 422 });
  }

  await e2eSignInAuth.api.signInEmailOTP({ body: { email, otp } });
  return NextResponse.json({ ok: true });
}

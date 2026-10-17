import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCustomerOtpResendState } from "@ammari/auth/customer";
import { recordIpThrottleAttempt } from "@ammari/auth/ip-throttle";
import { db } from "@ammari/db";

// A SEPARATE per-IP cap from the OTP-send abuse guard (createCustomerAuth's own
// OTP_IP_ABUSE_WINDOW_SECONDS/OTP_IP_ABUSE_MAX) — see @ammari/auth's shared/ip-throttle.ts for
// the full reasoning. This endpoint has no OTP of its own to send, so without this it could be
// called without limit to probe whether a given email recently requested a code. 30/10min is
// comfortably above any real login form's own usage (it calls this once per send attempt) while
// still bounding that probe.
const IP_THROTTLE_WINDOW_SECONDS = 10 * 60;
const IP_THROTTLE_MAX = 30;

// Read-only, no side effects on the OTP flow itself (see getCustomerOtpResendState's own doc
// comment in @ammari/auth/customer/customer-data.ts) — tells the login form which of "Case A"
// (an earlier sign-in code for this email is still valid) or "Case B" (it's gone — consumed,
// expired, or locked out) applies while the per-email 60s resend cooldown is active, WITHOUT ever
// calling the real send endpoint, which would itself overwrite a still-valid Case A code. See
// login-form.tsx's own `sendOtp()` for the bug this exists to fix: the client used to decide
// this purely from this BROWSER's own localStorage memory, which has no way to know the earlier
// code was already consumed by a successful sign-in.
//
// The response NEVER reveals whether an account exists for the given email — only
// `cooldownRemainingSeconds`/`hasActiveCode`, which getCustomerOtpResendState computes purely
// from the (email-keyed, not account-keyed) throttle/verification rows. Self sign-up means there
// is no "known vs unknown customer" distinction to leak here in the first place.
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Same header this app's own Better Auth instance reads IPs from (createCustomerAuth's
  // `ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] }`). "unknown" is a deliberate shared
  // fallback bucket, not a bypass: a request with no Cloudflare header (should never happen in
  // production — only ever reachable in local dev) still gets rate-limited, just lumped together
  // with every other headerless request instead of silently skipping the check.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipDecision = await recordIpThrottleAttempt(db, ip, { windowSeconds: IP_THROTTLE_WINDOW_SECONDS, max: IP_THROTTLE_MAX });
  if (ipDecision.limited) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body: unknown = await request.json().catch(() => null);
  const email = typeof (body as { email?: unknown } | null)?.email === "string" ? (body as { email: string }).email : null;
  if (!email) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const state = await getCustomerOtpResendState(db, email);
  return NextResponse.json(state);
}

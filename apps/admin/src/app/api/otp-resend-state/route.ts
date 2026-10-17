import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getStaffOtpResendState } from "@ammari/auth/staff";
import { recordIpThrottleAttempt } from "@ammari/auth/ip-throttle";
import { db } from "@ammari/db";

// A SEPARATE per-IP cap from the OTP-send abuse guard (createStaffAuth's own
// OTP_IP_ABUSE_WINDOW_SECONDS/OTP_IP_ABUSE_MAX) — see @ammari/auth's shared/ip-throttle.ts for
// the full reasoning, and apps/web's own identical route for the mirror. This endpoint has no
// OTP of its own to send, so without this it could be called without limit to probe whether a
// given email recently requested a code.
const IP_THROTTLE_WINDOW_SECONDS = 10 * 60;
const IP_THROTTLE_MAX = 30;

// Read-only, no side effects on the OTP flow itself (see getStaffOtpResendState's own doc
// comment in @ammari/auth/staff/staff-data.ts) — same mirror of apps/web's own route, see that
// file's doc comment for the full reasoning.
//
// The response NEVER reveals whether the email belongs to an active staff account — only
// `cooldownRemainingSeconds`/`hasActiveCode`, which getStaffOtpResendState computes purely from
// the (email-keyed, not staff-account-keyed) throttle/verification rows, the same no-enumeration
// posture every other part of the staff OTP flow already takes.
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Same header this app's own Better Auth instance reads IPs from (createStaffAuth's
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

  const state = await getStaffOtpResendState(db, email);
  return NextResponse.json(state);
}

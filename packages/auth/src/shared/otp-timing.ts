/** Client-safe OTP UX timing — the ONE place both the server config (staff/customer Better Auth
 * factories' own `expiresIn`) and the client-side countdown UI (apps/admin, apps/web login
 * forms) read these two numbers from, so the displayed countdown can never silently drift from
 * what the server actually enforces. Safe to import from a "use client" bundle: no secrets, no
 * server-only imports, just two integers. */

/** CLAUDE.md's OTP rule: a code is valid for exactly 5 minutes. */
export const OTP_EXPIRES_IN_SECONDS = 5 * 60;

/** Minimum time a customer/staff member must wait before requesting a fresh code for the same
 * email — see shared/email-throttle.ts's `cooldownActive` for the server-side enforcement (a
 * silent no-op, same anti-enumeration posture as every other throttle outcome here; the client
 * countdown is what actually keeps a normal user from ever hitting it). */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

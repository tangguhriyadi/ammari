import { and, eq, gt } from "drizzle-orm";
import type { db as defaultDb } from "@ammari/db";
import { customerAuthVerifications, customers } from "@ammari/db/schema";
import { getEmailCooldownRemainingSeconds } from "../shared/email-throttle";
import { OTP_RESEND_COOLDOWN_SECONDS } from "../shared/otp-timing";

export type Database = typeof defaultDb;

export interface OtpResendState {
  /** Seconds until a fresh sign-in OTP send is allowed again for this email; 0 means nothing is
   * blocking a send right now. */
  cooldownRemainingSeconds: number;
  /** Only meaningful when `cooldownRemainingSeconds > 0`. true ("Case A" in login-form.tsx's own
   * doc comments): an earlier sign-in code for this email is still unexpired and hasn't been
   * consumed (a successful sign-in), expired, or invalidated by 5 wrong attempts — the UI can
   * safely tell the user to keep using it. false ("Case B"): that code is gone, but the cooldown
   * is still active — a fresh send is blocked and there is nothing left for the user to enter,
   * so the UI must say so instead of silently stranding them on a code step with no valid code. */
  hasActiveCode: boolean;
}

/** Mirrors better-auth's own `toOTPIdentifier("sign-in", email)` (dist/plugins/email-otp/
 * utils.mjs) — not exported from its public API, so duplicated here rather than imported. Both
 * apps' own sign-in flow is the only OTP type this instance ever sends (see
 * create-customer-auth.ts's `type !== "sign-in"` early return), so this never needs to handle
 * any other type. */
function signInOtpIdentifier(email: string): string {
  return `sign-in-otp-${email}`;
}

/** Tells the login form whether a resend attempt made right now would be Case A or Case B (see
 * `OtpResendState`'s own doc comment) — read-only, calls neither better-auth's send endpoint nor
 * writes to `auth_email_throttle`, so asking never itself changes the answer. The email is
 * normalized (trim + lowercase) the same way better-auth's own endpoints normalize it before
 * building their identifier/throttle keys. */
export async function getCustomerOtpResendState(db: Database, email: string): Promise<OtpResendState> {
  const normalizedEmail = email.trim().toLowerCase();
  const cooldownRemainingSeconds = await getEmailCooldownRemainingSeconds(db, normalizedEmail, OTP_RESEND_COOLDOWN_SECONDS);
  if (cooldownRemainingSeconds === 0) return { cooldownRemainingSeconds: 0, hasActiveCode: false };

  const [activeCode] = await db
    .select({ id: customerAuthVerifications.id })
    .from(customerAuthVerifications)
    .where(
      and(
        eq(customerAuthVerifications.identifier, signInOtpIdentifier(normalizedEmail)),
        gt(customerAuthVerifications.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return { cooldownRemainingSeconds, hasActiveCode: Boolean(activeCode) };
}

/** The name a customer account gets when its login carried none (email OTP): shown on /account
 * until the buyer sets their own (2026-10-21 sandbox run), never used as a greeting or a recipient. */
export const CUSTOMER_PLACEHOLDER_NAME = "Pelanggan Ammari";

export interface CustomerIdentity {
  id: string;
  name: string;
  email: string;
}

/** `databaseHooks.user.create.before`'s link-or-create logic — the one real behavioral fork
 * from staff's equivalent (`loadActiveStaffForEmail`, which only ever links to a pre-existing
 * row and rejects everything else). Self sign-up means there is usually no pre-existing
 * `customers` row at all for a brand-new buyer, so this creates one when no match exists.
 *
 * `customers.email` is `citext UNIQUE`, so a matching row can never be worked around by
 * inserting a second one — linking is the only possible outcome once a match exists. The one
 * case this refuses outright (returns `null`) is docs/SPEC.md §10.3's explicit rule: a sign-in
 * whose email isn't verified by ITS OWN provider for THIS sign-in (an unverified Google email,
 * in practice — email-OTP completion is itself proof of ownership, so it is always `true` here)
 * must not be allowed to attach to an existing customer it hasn't actually proven it owns.
 *
 * Scope note: `user.create.before` only runs when better-auth is about to create a BRAND-NEW
 * `customer_auth_users` row — i.e. the first time an email is ever seen by this instance at
 * all. An email that already HAS a `customer_auth_users` row (e.g. it signed up via OTP first,
 * and a Google sign-in for the same email arrives later) never reaches this hook — better-auth
 * resolves that case itself inside its own account-linking logic
 * (`better-auth/dist/oauth2/link-account.mjs`), which enforces an equivalent (and, by default,
 * stricter — it also requires the existing local user's own `emailVerified` to already be
 * true) check via its `trustedProviders`/`requireLocalEmailVerified` options. This function is
 * genuinely the sole guard ONLY for an email's very first identity; the "second provider, same
 * email" case is enforced in better-auth's own code, not here — don't assume a future change to
 * this function alone covers both.
 *
 * Deliberately NOT a SELECT-then-INSERT (CLAUDE.md: anything that can happen concurrently must
 * not be check-then-write) — this attempts the INSERT first, with `onConflictDoNothing`
 * (same idiom `packages/db/src/seed.ts` already uses). Two concurrent first-ever sign-ins for
 * the same brand-new email then resolve to the SAME row (whichever INSERT actually lands) via
 * the fallback SELECT below, instead of the loser crashing on a raw, uncaught 23505 — which,
 * unhandled inside this hook, would abort that user's entire sign-in with a 500 instead of
 * gracefully signing them in. */
export async function loadOrCreateCustomerForEmail(
  db: Database,
  params: { email: string; name: string; emailVerified: boolean },
): Promise<CustomerIdentity | null> {
  const [created] = await db
    .insert(customers)
    .values({
      email: params.email,
      name: params.name,
      emailVerifiedAt: params.emailVerified ? new Date() : null,
    })
    .onConflictDoNothing({ target: customers.email })
    .returning({ id: customers.id, name: customers.name, email: customers.email });

  if (created) {
    // No prior row existed at all — nothing to "take over," so a brand-new identity succeeds
    // regardless of `emailVerified` (there's no existing owner to impersonate yet).
    return { id: created.id, name: created.name, email: created.email! };
  }

  // The INSERT conflicted — a row already existed. This is exactly the link-vs-reject decision
  // described above, which only ever applies once there's something pre-existing to attach to.
  const [existing] = await db
    .select({ id: customers.id, name: customers.name, email: customers.email, emailVerifiedAt: customers.emailVerifiedAt })
    .from(customers)
    .where(eq(customers.email, params.email))
    .limit(1);
  if (!existing) {
    // Unreachable in practice (nothing deletes `customers` rows), but a thrown error here is
    // the correct failure mode if it ever somehow were — never silently treat a vanished row as
    // "safe to create a new one for," which would resurrect exactly the race this function
    // exists to close.
    throw new Error(`customers row for "${params.email}" vanished between insert conflict and select`);
  }

  if (!params.emailVerified) return null;
  // Backfills verification for a row that pre-dates this sign-in (e.g. a staff-entered manual
  // order never captured it) — never clears an already-set timestamp.
  if (!existing.emailVerifiedAt) {
    await db.update(customers).set({ emailVerifiedAt: new Date() }).where(eq(customers.id, existing.id));
  }
  return { id: existing.id, name: existing.name, email: existing.email! };
}

"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { OTP_EXPIRES_IN_SECONDS, OTP_RESEND_COOLDOWN_SECONDS } from "@ammari/auth/otp-timing";
import { formatCountdown, getRememberedOtpSendAttempt, rememberOtpSendAttempt, useCountdown } from "@ammari/ui/lib";
import { GoogleLogo } from "@ammari/ui";

// One fixed, generic message for every failure mode (wrong code, expired code, too many
// attempts, unknown email, inactive staff, Google rejection) — the UI never surfaces Better
// Auth's internal error text, because those cases are not guaranteed to be distinguishable from
// each other at that layer. The real access-control boundary is `validateUserInfo` /
// `databaseHooks` in @ammari/auth, not this message. A 429 (Better Auth's own per-IP rate limit,
// now actually reachable since this calls the real HTTP endpoint) gets its own message instead —
// that's a legitimate, non-enumerating signal, not an account-existence leak.
const GENERIC_ERROR = "Kode tidak valid atau akun tidak ditemukan.";
const RATE_LIMITED_ERROR = "Terlalu banyak percobaan. Coba lagi nanti.";

// sessionStorage, not localStorage: this is one login attempt's own in-flight state, not
// something that should outlive the tab. Scoped to this one key so a stale entry from a much
// older session never resurrects — `loadStoredSession` below also re-validates against the real
// expiry before trusting it at all.
const STORAGE_KEY = "ammari-admin-otp-session";

// Separate from STORAGE_KEY above (sessionStorage, cleared on login success/"Ganti email") —
// this one lives in localStorage and survives exactly that clearing: see @ammari/ui/lib's
// otp-send-guard.ts for the bug this fixes (logout, then immediately log back in with the same
// email, within the server's 60s per-email cooldown).
const OTP_LAST_SEND_STORAGE_KEY_PREFIX = "ammari-admin-otp-last-send";

interface OtpSession {
  email: string;
  /** Epoch ms when the code currently in flight was (re)sent — the ONE value the expiry and
   * resend countdowns are both derived from (see OTP_EXPIRES_IN_SECONDS/
   * OTP_RESEND_COOLDOWN_SECONDS), and the ONE value persisted across a refresh. */
  sentAt: number;
}

function loadStoredSession(): OtpSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Partial<OtpSession>).email !== "string" ||
      typeof (parsed as Partial<OtpSession>).sentAt !== "number"
    ) {
      return null;
    }
    const session = parsed as OtpSession;
    // Don't resurrect a session whose code has already expired server-side — same cutoff the
    // server itself enforces (OTP_EXPIRES_IN_SECONDS), so a stale tab reopened well after
    // sending just falls back to the plain email step instead of showing a dead countdown.
    if (Date.now() - session.sentAt > OTP_EXPIRES_IN_SECONDS * 1000) return null;
    return session;
  } catch {
    return null;
  }
}

function storeSession(session: OtpSession | null): void {
  if (typeof window === "undefined") return;
  try {
    if (session) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage can throw (private-mode quirks, storage disabled) — losing refresh
    // persistence is a UX nicety, not a correctness requirement, so this stays a no-op.
  }
}

// `useSyncExternalStore`, not a `useEffect` + `setState` pair, for reading sessionStorage once at
// mount: React special-cases this hook's `getServerSnapshot` precisely so a client-only value can
// differ from the server-rendered HTML without that being a hydration error — a manual
// `useEffect` doing the equivalent `setState` runs into both an eslint
// `react-hooks/set-state-in-effect` violation and, more importantly, the exact "cascading
// render" cost that rule warns about. No real subscription needed (this repo has no multi-tab
// sync requirement for a login screen), so `subscribe` is a stable no-op that never calls back —
// we only ever want the ONE read this hook performs at mount; everything after that is this
// component's own state.
function subscribeNever(): () => void {
  return () => {};
}

// `getSnapshot` must return a referentially stable value when nothing's changed — otherwise
// React would see a "new" value on every render and either re-render in a loop or warn that the
// snapshot isn't cached. Computed (and cached) once per page load, which is exactly the one
// moment this needs to reflect sessionStorage's current content; the component's OWN state is
// the source of truth for everything after that.
let cachedInitialSession: OtpSession | null | undefined;

function getSnapshot(): OtpSession | null {
  if (cachedInitialSession === undefined) cachedInitialSession = loadStoredSession();
  return cachedInitialSession;
}

function getServerSnapshot(): OtpSession | null {
  return null;
}

async function signInWithGoogle() {
  await authClient.signIn.social({ provider: "google", callbackURL: "/" });
}

type Step = "email" | "sent";

export function LoginForm({ isGoogleConfigured }: { isGoogleConfigured: boolean }) {
  const router = useRouter();
  // Restores a still-valid in-flight OTP session after a refresh. `getServerSnapshot` returning
  // `null` is what keeps the server-rendered HTML (always the email step) consistent with
  // hydration — React is specifically built to reconcile a client-only value like this one
  // without treating it as a mismatch, unlike computing it from a plain `useState` initializer.
  const restored = useSyncExternalStore(subscribeNever, getSnapshot, getServerSnapshot);
  const [step, setStep] = useState<Step>(() => (restored ? "sent" : "email"));
  const [email, setEmail] = useState(() => restored?.email ?? "");
  const [sentAt, setSentAt] = useState<number | null>(() => restored?.sentAt ?? null);
  const [sendError, setSendError] = useState<string | undefined>();
  const [verifyError, setVerifyError] = useState<string | undefined>();
  // True when the most recent "send" didn't actually trigger a new email — a remembered attempt
  // from this browser (possibly an earlier login session already logged out of) was still inside
  // the server's 60s per-email cooldown, so the PREVIOUS code is still the live one. Drives the
  // "Kode sebelumnya masih berlaku" message in place of "Kode telah dikirim ke ..." below.
  const [skippedResend, setSkippedResend] = useState(false);
  const [sendPending, startSendTransition] = useTransition();
  const [verifyPending, startVerifyTransition] = useTransition();

  async function sendOtp(targetEmail: string): Promise<void> {
    const now = Date.now();
    // better-auth's own send endpoint always returns `{success: true}` even when
    // sendVerificationOTP silently no-ops because the per-email cooldown is still active — this
    // is the one place that can actually tell the difference, by remembering what THIS browser
    // itself last did, independent of the per-flow session state cleared on login/"Ganti email"
    // (see @ammari/ui/lib's otp-send-guard.ts for the full bug). Previously this code assumed the
    // client-side cooldown alone prevented ever hitting this case — true within ONE session, but
    // not across a logout immediately followed by a fresh login with the same email, which has
    // no memory of the earlier send at all.
    const remembered = await getRememberedOtpSendAttempt(OTP_LAST_SEND_STORAGE_KEY_PREFIX, targetEmail, OTP_EXPIRES_IN_SECONDS * 1000);
    if (remembered !== null && now - remembered < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      setSendError(undefined);
      setVerifyError(undefined);
      setEmail(targetEmail);
      setSentAt(remembered); // the REAL sentAt — so the expiry/resend countdowns stay accurate
      setStep("sent");
      setSkippedResend(true);
      storeSession({ email: targetEmail, sentAt: remembered });
      return;
    }

    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: targetEmail, type: "sign-in" });
    if (error?.status === 429) {
      setSendError(RATE_LIMITED_ERROR);
      return;
    }
    setSendError(undefined);
    setVerifyError(undefined);
    setEmail(targetEmail);
    setSentAt(now);
    setStep("sent");
    setSkippedResend(false);
    storeSession({ email: targetEmail, sentAt: now });
    await rememberOtpSendAttempt(OTP_LAST_SEND_STORAGE_KEY_PREFIX, targetEmail, now);
  }

  function handleSendSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetEmail = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!targetEmail) {
      setSendError("Masukkan email terlebih dahulu.");
      return;
    }
    startSendTransition(() => sendOtp(targetEmail));
  }

  function handleResend() {
    startSendTransition(() => sendOtp(email));
  }

  // Returns to the email step with the previous email prefilled (the email step's own input
  // below reads it via `defaultValue`) and the OTP input cleared (that step remounts fresh) —
  // never a network call, and the anti-enumeration behavior above is untouched: sending from
  // here goes through the exact same sendOtp() path, which always advances to "sent" the same
  // way regardless of whether the email turns out to be valid.
  function handleChangeEmail() {
    setStep("email");
    setSentAt(null);
    setSendError(undefined);
    setVerifyError(undefined);
    storeSession(null);
  }

  function handleVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const otp = String(new FormData(event.currentTarget).get("otp") ?? "").trim();
    if (!otp) {
      setVerifyError(GENERIC_ERROR);
      return;
    }
    startVerifyTransition(async () => {
      const { error } = await authClient.signIn.emailOtp({ email, otp });
      if (error) {
        setVerifyError(error.status === 429 ? RATE_LIMITED_ERROR : GENERIC_ERROR);
        return;
      }
      storeSession(null);
      router.push("/");
      router.refresh();
    });
  }

  const expiresAt = sentAt !== null ? sentAt + OTP_EXPIRES_IN_SECONDS * 1000 : null;
  const resendAvailableAt = sentAt !== null ? sentAt + OTP_RESEND_COOLDOWN_SECONDS * 1000 : null;
  const remainingExpiryMs = useCountdown(expiresAt);
  const remainingResendMs = useCountdown(resendAvailableAt);
  const isExpired = step === "sent" && expiresAt !== null && remainingExpiryMs <= 0;
  const canResend = step === "sent" && resendAvailableAt !== null && remainingResendMs <= 0;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white px-4 py-10">
      <h1 className="text-2xl font-semibold text-[#695A5A]">Ammari Admin</h1>

      {step === "email" ? (
        // key="send"/"verify" below — without it, React reconciles these two <form>s as the
        // SAME element across the step transition (both are a <form> at the same tree position),
        // diffing their children instead of unmounting/remounting. The email <input> here (no
        // `value`, uncontrolled) and the verify form's hidden "email" input (`value={...}`,
        // controlled) then collide into one DOM node going from uncontrolled to controlled,
        // which is exactly the "A component is changing an uncontrolled input to be controlled"
        // warning. A `key` forces a real remount instead.
        <form key="send" onSubmit={handleSendSubmit} className="flex w-full max-w-sm flex-col gap-3">
          <label htmlFor="email" className="text-sm font-medium text-black">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue={email}
            className="h-12 w-full rounded-md border border-[#695A5A] px-3 text-base text-black"
            placeholder="nama@ammari.id"
          />
          {sendError && (
            <p role="alert" className="text-sm text-[#8a3b3b]">
              {sendError}
            </p>
          )}
          <button
            type="submit"
            disabled={sendPending}
            className="h-12 w-full rounded-md bg-[#695A5A] text-base font-medium text-white disabled:opacity-60"
          >
            {sendPending ? "Mengirim..." : "Kirim kode"}
          </button>

          {isGoogleConfigured && (
            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md border border-[#695A5A] text-base font-medium text-[#695A5A]"
            >
              <GoogleLogo />
              Masuk dengan Google
            </button>
          )}
        </form>
      ) : (
        <form key="verify" onSubmit={handleVerifySubmit} className="flex w-full max-w-sm flex-col gap-3">
          {/* Two separate elements on purpose: this one is the ONLY thing screen readers hear,
              and it changes just twice (sent -> expired) instead of once a second — a countdown
              re-announced every second would be unusable with a screen reader. */}
          <p className="sr-only" aria-live="polite">
            {isExpired
              ? "Kode sudah kedaluwarsa."
              : skippedResend
                ? `Kode sebelumnya masih berlaku, cek email kamu di ${email}. Berlaku 5 menit.`
                : `Kode telah dikirim ke ${email}. Berlaku 5 menit.`}
          </p>
          <p className="text-sm text-black" aria-hidden="true">
            {skippedResend ? (
              <>
                Kode sebelumnya masih berlaku, cek email kamu di <span className="font-medium">{email}</span>.
              </>
            ) : (
              <>
                Kode telah dikirim ke <span className="font-medium">{email}</span>.
              </>
            )}
          </p>
          <p className="text-sm text-[#695A5A]" aria-hidden="true">
            {isExpired ? "Kode sudah kedaluwarsa" : `Kode berlaku ${formatCountdown(remainingExpiryMs)}`}
          </p>

          <label htmlFor="otp" className="text-sm font-medium text-black">
            Kode (6 digit)
          </label>
          {/* key={sentAt}: a resend keeps this SAME form mounted (no step change), but the OTP
              input must still clear back to empty — an uncontrolled input only reads
              `defaultValue` on mount, so remounting it on every new `sentAt` is what makes that
              happen, same remount trick as the step-level `key` above. */}
          <input
            key={sentAt}
            id="otp"
            name="otp"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            autoFocus
            className="h-12 w-full rounded-md border border-[#695A5A] px-3 text-center text-xl tracking-[0.5em] text-black"
            placeholder="______"
          />
          {verifyError && (
            <p role="alert" className="text-sm text-[#8a3b3b]">
              {verifyError}
            </p>
          )}
          <button
            type="submit"
            disabled={verifyPending || isExpired}
            className="h-12 w-full rounded-md bg-[#695A5A] text-base font-medium text-white disabled:opacity-60"
          >
            {verifyPending ? "Memeriksa..." : "Masuk"}
          </button>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleChangeEmail}
              className="h-12 flex-1 rounded-md border border-[#695A5A] text-base font-medium text-[#695A5A]"
            >
              Ganti email
            </button>
            <button
              type="button"
              onClick={handleResend}
              disabled={!canResend || sendPending}
              className="h-12 flex-1 rounded-md border border-[#695A5A] text-base font-medium text-[#695A5A] disabled:opacity-60"
            >
              {canResend ? "Kirim ulang kode" : `Kirim ulang dalam ${formatCountdown(remainingResendMs)}`}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, GoogleLogo, Input, Label } from "@ammari/ui";
import { formatCountdown, getRememberedOtpSendAttempt, rememberOtpSendAttempt, useCountdown } from "@ammari/ui/lib";
import { authClient } from "@/lib/auth/client";
import { OTP_EXPIRES_IN_SECONDS, OTP_RESEND_COOLDOWN_SECONDS } from "@ammari/auth/otp-timing";

// Separate from STORAGE_KEY below (sessionStorage, cleared on login success/"Ganti email") —
// this one lives in localStorage and survives exactly that clearing, which is the whole point:
// see @ammari/ui/lib's otp-send-guard.ts for the bug this fixes (logout, then immediately log
// back in with the same email, within the server's 60s per-email cooldown).
const OTP_LAST_SEND_STORAGE_KEY_PREFIX = "ammari-web-otp-last-send";

// One fixed, generic message for every OTP failure mode (wrong code, expired code, too many
// attempts, unknown email) — self sign-up means there's no account-existence distinction to
// protect here the way staff's login has, but a single message still avoids leaking which
// specific failure occurred. A 429 (Better Auth's own per-IP rate limit) gets its own message —
// a legitimate signal, not an enumeration leak.
const GENERIC_ERROR = "Kode tidak valid. Coba lagi.";
const RATE_LIMITED_ERROR = "Terlalu banyak percobaan. Coba lagi nanti.";

// See apps/admin's own login-form.tsx for the full reasoning behind every piece of this file —
// this is the same design, just restyled with @ammari/ui's own components.
const STORAGE_KEY = "ammari-web-otp-session";

interface OtpSession {
  email: string;
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

function subscribeNever(): () => void {
  return () => {};
}

let cachedInitialSession: OtpSession | null | undefined;

function getSnapshot(): OtpSession | null {
  if (cachedInitialSession === undefined) cachedInitialSession = loadStoredSession();
  return cachedInitialSession;
}

function getServerSnapshot(): OtpSession | null {
  return null;
}

type Step = "email" | "sent";

export function LoginForm({ isGoogleConfigured, next }: { isGoogleConfigured: boolean; next: string }) {
  const router = useRouter();
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

  async function signInWithGoogle() {
    // `next` was already sanitized by the server page before being handed to this client
    // component — safe to pass straight through as the OAuth callback target.
    await authClient.signIn.social({ provider: "google", callbackURL: next });
  }

  async function sendOtp(targetEmail: string): Promise<void> {
    const now = Date.now();
    // better-auth's own send endpoint always returns `{success: true}` even when
    // sendVerificationOTP silently no-ops because the per-email cooldown is still active (see
    // @ammari/ui/lib's otp-send-guard.ts for the full bug this guards against) — so THIS is the
    // one place that can actually tell the difference, by remembering what THIS browser itself
    // last did, independent of the per-flow session state that gets cleared on login/"Ganti
    // email".
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
      router.push(next);
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
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 px-4 py-10">
      <h1 className="font-serif text-4xl font-light text-brand">AMMARI</h1>

      {step === "email" ? (
        // key="send"/"verify" forces a real remount across the step transition — see
        // apps/admin's own login-form.tsx for why (an uncontrolled email input here colliding
        // with the verify form's controlled hidden input at the same tree position otherwise).
        <form key="send" onSubmit={handleSendSubmit} className="flex w-full max-w-sm flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              defaultValue={email}
              placeholder="nama@email.com"
            />
          </div>
          {sendError && (
            <p role="alert" className="text-sm text-danger-700">
              {sendError}
            </p>
          )}
          <Button type="submit" loading={sendPending}>
            Kirim kode
          </Button>

          {isGoogleConfigured && (
            <Button type="button" variant="secondary" onClick={() => void signInWithGoogle()}>
              <GoogleLogo />
              Masuk dengan Google
            </Button>
          )}
        </form>
      ) : (
        <form key="verify" onSubmit={handleVerifySubmit} className="flex w-full max-w-sm flex-col gap-4">
          {/* Two separate elements on purpose: this one is the ONLY thing screen readers hear,
              and it changes just twice (sent -> expired) instead of once a second. */}
          <p className="sr-only" aria-live="polite">
            {isExpired
              ? "Kode sudah kedaluwarsa."
              : skippedResend
                ? `Kode sebelumnya masih berlaku, cek email kamu di ${email}. Berlaku 5 menit.`
                : `Kode telah dikirim ke ${email}. Berlaku 5 menit.`}
          </p>
          <p className="text-sm text-neutral-700" aria-hidden="true">
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
          <p className="text-sm text-neutral-700" aria-hidden="true">
            {isExpired ? "Kode sudah kedaluwarsa" : `Kode berlaku ${formatCountdown(remainingExpiryMs)}`}
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="otp">Kode (6 digit)</Label>
            {/* key={sentAt}: a resend keeps this SAME form mounted, but the OTP input must still
                clear back to empty — remounting it on every new `sentAt` is what makes that
                happen (same remount trick as the step-level `key` above). */}
            <Input
              key={sentAt}
              id="otp"
              name="otp"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
              autoFocus
              className="text-center text-xl tracking-[0.5em]"
              placeholder="______"
            />
          </div>
          {verifyError && (
            <p role="alert" className="text-sm text-danger-700">
              {verifyError}
            </p>
          )}
          <Button type="submit" loading={verifyPending} disabled={isExpired}>
            Masuk
          </Button>

          <div className="flex gap-3">
            <Button type="button" variant="secondary" className="flex-1" onClick={handleChangeEmail}>
              Ganti email
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              disabled={!canResend || sendPending}
              onClick={handleResend}
            >
              {canResend ? "Kirim ulang kode" : `Kirim ulang dalam ${formatCountdown(remainingResendMs)}`}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

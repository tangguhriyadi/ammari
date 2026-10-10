"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@ammari/ui";
import { authClient } from "@/lib/auth/client";

// One fixed, generic message for every OTP failure mode (wrong code, expired code, too many
// attempts, unknown email) — self sign-up means there's no account-existence distinction to
// protect here the way staff's login has, but a single message still avoids leaking which
// specific failure occurred. A 429 (Better Auth's own per-IP rate limit) gets its own message —
// a legitimate signal, not an enumeration leak.
const GENERIC_ERROR = "Kode tidak valid. Coba lagi.";
const RATE_LIMITED_ERROR = "Terlalu banyak percobaan. Coba lagi nanti.";

type SendOtpState = { step: "email" | "sent"; email: string; error?: string };
type VerifyOtpState = { error?: string };

const initialSendState: SendOtpState = { step: "email", email: "" };
const initialVerifyState: VerifyOtpState = {};

async function sendOtp(_prev: SendOtpState, formData: FormData): Promise<SendOtpState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { step: "email", email: "", error: "Masukkan email terlebih dahulu." };

  const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  if (error?.status === 429) return { step: "email", email, error: RATE_LIMITED_ERROR };
  return { step: "sent", email };
}

export function LoginForm({ isGoogleConfigured, next }: { isGoogleConfigured: boolean; next: string }) {
  const router = useRouter();

  async function signInWithGoogle() {
    // `next` was already sanitized by the server page before being handed to this client
    // component — safe to pass straight through as the OAuth callback target.
    await authClient.signIn.social({ provider: "google", callbackURL: next });
  }

  const [sendState, sendAction, sendPending] = useActionState(sendOtp, initialSendState);
  const [verifyState, verifyAction, verifyPending] = useActionState(
    async (_prev: VerifyOtpState, formData: FormData): Promise<VerifyOtpState> => {
      const email = String(formData.get("email") ?? "").trim();
      const otp = String(formData.get("otp") ?? "").trim();
      if (!email || !otp) return { error: GENERIC_ERROR };

      const { error } = await authClient.signIn.emailOtp({ email, otp });
      if (error) return { error: error.status === 429 ? RATE_LIMITED_ERROR : GENERIC_ERROR };

      router.push(next);
      router.refresh();
      return {};
    },
    initialVerifyState,
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 px-4 py-10">
      <h1 className="font-serif text-4xl font-light text-brand">AMMARI</h1>

      {sendState.step === "email" ? (
        // key="send"/"verify" forces a real remount across the step transition — see
        // apps/admin's own login-form.tsx for why (an uncontrolled email input here colliding
        // with the verify form's controlled hidden input at the same tree position otherwise).
        <form key="send" action={sendAction} className="flex w-full max-w-sm flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" placeholder="nama@email.com" />
          </div>
          {sendState.error && (
            <p role="alert" className="text-sm text-danger-700">
              {sendState.error}
            </p>
          )}
          <Button type="submit" loading={sendPending}>
            Kirim kode
          </Button>

          {isGoogleConfigured && (
            <Button type="button" variant="secondary" onClick={() => void signInWithGoogle()}>
              Masuk dengan Google
            </Button>
          )}
        </form>
      ) : (
        <form key="verify" action={verifyAction} className="flex w-full max-w-sm flex-col gap-4">
          <p className="text-sm text-neutral-700" aria-live="polite">
            Kode telah dikirim ke <span className="font-medium">{sendState.email}</span>.
          </p>
          <input type="hidden" name="email" value={sendState.email} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="otp">Kode (6 digit)</Label>
            <Input
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
          {verifyState.error && (
            <p role="alert" className="text-sm text-danger-700">
              {verifyState.error}
            </p>
          )}
          <Button type="submit" loading={verifyPending}>
            Masuk
          </Button>
        </form>
      )}
    </div>
  );
}

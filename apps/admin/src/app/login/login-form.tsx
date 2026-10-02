"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

// One fixed, generic message for every failure mode (wrong code, expired code, too many
// attempts, unknown email, inactive staff, Google rejection) — the UI never surfaces Better
// Auth's internal error text, because those cases are not guaranteed to be distinguishable from
// each other at that layer. The real access-control boundary is `validateUserInfo` /
// `databaseHooks` in @ammari/auth, not this message. A 429 (Better Auth's own per-IP rate limit,
// now actually reachable since this calls the real HTTP endpoint) gets its own message instead —
// that's a legitimate, non-enumerating signal, not an account-existence leak.
const GENERIC_ERROR = "Kode tidak valid atau akun tidak ditemukan.";
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
  // Any other outcome (sent, unknown account, throttled) advances identically — see GENERIC_ERROR.
  return { step: "sent", email };
}

async function signInWithGoogle() {
  await authClient.signIn.social({ provider: "google", callbackURL: "/" });
}

export function LoginForm({ isGoogleConfigured }: { isGoogleConfigured: boolean }) {
  const router = useRouter();
  const [sendState, sendAction, sendPending] = useActionState(sendOtp, initialSendState);
  const [verifyState, verifyAction, verifyPending] = useActionState(
    async (_prev: VerifyOtpState, formData: FormData): Promise<VerifyOtpState> => {
      const email = String(formData.get("email") ?? "").trim();
      const otp = String(formData.get("otp") ?? "").trim();
      if (!email || !otp) return { error: GENERIC_ERROR };

      const { error } = await authClient.signIn.emailOtp({ email, otp });
      if (error) return { error: error.status === 429 ? RATE_LIMITED_ERROR : GENERIC_ERROR };

      router.push("/");
      router.refresh();
      return {};
    },
    initialVerifyState,
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white px-4 py-10">
      <h1 className="text-2xl font-semibold text-[#695A5A]">Ammari Admin</h1>

      {sendState.step === "email" ? (
        // key="send"/"verify" below — without it, React reconciles these two <form>s as the
        // SAME element across the step transition (both are a <form> at the same tree position),
        // diffing their children instead of unmounting/remounting. The email <input> here (no
        // `value`, uncontrolled) and the verify form's hidden "email" input (`value={...}`,
        // controlled) then collide into one DOM node going from uncontrolled to controlled,
        // which is exactly the "A component is changing an uncontrolled input to be controlled"
        // warning. A `key` forces a real remount instead.
        <form key="send" action={sendAction} className="flex w-full max-w-sm flex-col gap-3">
          <label htmlFor="email" className="text-sm font-medium text-black">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="h-12 w-full rounded-md border border-[#695A5A] px-3 text-base text-black"
            placeholder="nama@ammari.id"
          />
          {sendState.error && (
            <p role="alert" className="text-sm text-[#8a3b3b]">
              {sendState.error}
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
              className="h-12 w-full rounded-md border border-[#695A5A] text-base font-medium text-[#695A5A]"
            >
              Masuk dengan Google
            </button>
          )}
        </form>
      ) : (
        <form key="verify" action={verifyAction} className="flex w-full max-w-sm flex-col gap-3">
          {/* aria-live announces the step change itself; autoFocus below (fired once, on this
              form's single mount from the key="verify" remount) moves keyboard focus into the
              new form so users don't have to tab up from the top of the page to find it. */}
          <p className="text-sm text-black" aria-live="polite">
            Kode telah dikirim ke <span className="font-medium">{sendState.email}</span>.
          </p>
          <input type="hidden" name="email" value={sendState.email} />
          <label htmlFor="otp" className="text-sm font-medium text-black">
            Kode (6 digit)
          </label>
          <input
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
          {verifyState.error && (
            <p role="alert" className="text-sm text-[#8a3b3b]">
              {verifyState.error}
            </p>
          )}
          <button
            type="submit"
            disabled={verifyPending}
            className="h-12 w-full rounded-md bg-[#695A5A] text-base font-medium text-white disabled:opacity-60"
          >
            {verifyPending ? "Memeriksa..." : "Masuk"}
          </button>
        </form>
      )}
    </div>
  );
}

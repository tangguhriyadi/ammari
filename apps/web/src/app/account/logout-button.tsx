"use client";

import { Button } from "@ammari/ui";
import { clearRememberedOtpSendAttempt } from "@ammari/ui/lib";
import { logoutAction } from "@/app/actions";

// Must match login-form.tsx's own OTP_LAST_SEND_STORAGE_KEY_PREFIX exactly — see that file's own
// doc comment for why this guard exists, and why it must be cleared on sign-out (the next
// sign-in, possibly by a different person on a shared device, must not inherit this one's
// same-browser memory of a send attempt for this email).
const OTP_LAST_SEND_STORAGE_KEY_PREFIX = "ammari-web-otp-last-send";

export function LogoutButton({ email }: { email: string | null }) {
  return (
    <form
      action={logoutAction}
      onSubmit={() => {
        if (email) void clearRememberedOtpSendAttempt(OTP_LAST_SEND_STORAGE_KEY_PREFIX, email);
      }}
    >
      <Button type="submit" variant="secondary">
        Keluar
      </Button>
    </form>
  );
}

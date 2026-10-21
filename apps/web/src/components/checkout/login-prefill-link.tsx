"use client";

import { OutlineLink } from "@/components/buttons";
import { LOGIN_FOR_ORDERS_HREF, storeLoginPrefill } from "@/lib/auth/login-prefill";

// "Masuk untuk melihat semua pesanan" on a guest order's finish page (docs/plans/cart-checkout.md
// §4.4): the email OTP login with the order's contact email filled in. It never logs in by itself
// (decision 16): the buyer still proves the email with the code. Lands on /account until the
// order list exists (`/orders`, session 15).

export function LoginPrefillLink({ email }: { email: string }) {
  return (
    <OutlineLink href={LOGIN_FOR_ORDERS_HREF} onClick={() => storeLoginPrefill(email)} className="w-full">
      Masuk untuk melihat semua pesanan
    </OutlineLink>
  );
}

"use server";

import { redirect } from "next/navigation";
import { signOutCustomer } from "@/lib/auth/sign-out";

/** "Bukan kamu? Keluar" on the checkout's locked contact card (docs/plans/cart-checkout.md §4.3):
 * signs out, then offers the login again with the way back to checkout. The cart belongs to the
 * account that was signed in, so the right person logs in and finds their own cart. Like every
 * logout it starts this browser fresh (lib/auth/sign-out.ts). */
export async function signOutFromCheckoutAction(): Promise<void> {
  await signOutCustomer();
  redirect("/login?next=%2Fcheckout");
}

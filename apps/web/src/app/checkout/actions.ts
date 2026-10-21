"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { customerAuth } from "@/lib/auth/customer";

/** "Bukan kamu? Keluar" on the checkout's locked contact card (docs/plans/cart-checkout.md §4.3):
 * signs out, then offers the login again with the way back to checkout. The cart belongs to the
 * account that was signed in, so the right person logs in and finds their own cart. */
export async function signOutFromCheckoutAction(): Promise<void> {
  await customerAuth.api.signOut({ headers: await headers() });
  redirect("/login?next=%2Fcheckout");
}

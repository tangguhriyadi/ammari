"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { databaseErrorLogFields } from "@ammari/commerce/checkout";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { getCartClientIp } from "@/lib/cart/ip";
import { CART_RATE_LIMITED_MESSAGE } from "@/lib/cart/messages";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { SAVED_ADDRESS_DELETE_FAILED_MESSAGE } from "@/lib/account/saved-address-messages";
import { SAVED_ADDRESS_DELETE_LIMIT, SAVED_ADDRESS_DELETE_WINDOW_SECONDS, deleteSavedAddresses } from "@/lib/account/saved-address";

export type DeleteSavedAddressResult = { ok: true } | { ok: false; message: string };

/** "Hapus alamat" on /account (lib/account/saved-address.ts). Takes nothing from the browser: the
 * customer comes from the session, and every saved address of that customer goes. Next's Origin
 * check on server actions is the CSRF guard; the per-IP limit is counted before the delete. Not
 * behind the cart flag, so a rollback never leaves a buyer unable to delete their data. A second
 * press (or another tab) deletes nothing and still answers ok. */
export async function deleteSavedAddressAction(): Promise<DeleteSavedAddressResult> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login?next=%2Faccount");
  try {
    const ip = await getCartClientIp("saved address delete");
    if (!ip) return { ok: false, message: SAVED_ADDRESS_DELETE_FAILED_MESSAGE };
    if ((await recordClaimAttemptAndCount(defaultDb, ip, "saved_address_delete", SAVED_ADDRESS_DELETE_WINDOW_SECONDS)) >= SAVED_ADDRESS_DELETE_LIMIT) {
      return { ok: false, message: CART_RATE_LIMITED_MESSAGE };
    }
    await deleteSavedAddresses(customer.id);
  } catch (error) {
    console.error("[account] saved address delete failed", { customerId: customer.id, ...databaseErrorLogFields(error) });
    return { ok: false, message: SAVED_ADDRESS_DELETE_FAILED_MESSAGE };
  }
  // The page re-renders in the same response: the contact offer stops saying it would replace a
  // saved address.
  refresh();
  return { ok: true };
}

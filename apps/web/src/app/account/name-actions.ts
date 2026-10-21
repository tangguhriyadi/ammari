"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { defaultDb } from "@/lib/db";
import { parseAccountName } from "@/lib/account/name";

export interface AccountNameState {
  error?: string;
  /** What was typed, kept on an error so the field does not lose it. */
  value?: string;
  /** The saved name: the form closes and shows it until the page is next loaded. */
  saved?: string;
}

/** "Simpan" of the name on /account (2026-10-21 sandbox run: a guest-created account showed
 * "Pelanggan Ammari"). Only the session's own customer row, re-read from the session here. */
export async function updateAccountNameAction(_prev: AccountNameState, formData: FormData): Promise<AccountNameState> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login?next=%2Faccount");
  const parsed = parseAccountName(formData.get("name"));
  if (!parsed.ok) return { error: parsed.message, value: String(formData.get("name") ?? "").slice(0, 200) };
  await defaultDb.update(customers).set({ name: parsed.name }).where(eq(customers.id, customer.id));
  // The page re-renders in the same response: the contact offer stops offering an order's name.
  refresh();
  return { saved: parsed.name };
}

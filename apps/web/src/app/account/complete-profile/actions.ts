"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { db } from "@ammari/db";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { isUniqueViolation } from "@/lib/errors";

// Same shape as customers_phone_format_check (packages/db/src/schema/customers.ts) — validated
// here too so a bad value gets a field-level message instead of surfacing as a raw DB error.
const PHONE_PATTERN = /^\+62[0-9]{8,13}$/;

export interface CompleteProfileState {
  error?: string;
}

export async function completeProfileAction(
  _prev: CompleteProfileState,
  formData: FormData,
): Promise<CompleteProfileState> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  if (!name) return { error: "Nama tidak boleh kosong." };
  if (phone && !PHONE_PATTERN.test(phone)) {
    return { error: "Nomor HP harus diawali +62, diikuti 8-13 digit (tanpa spasi atau tanda hubung)." };
  }

  try {
    await db
      .update(customers)
      .set({ name, phone: phone || null })
      .where(eq(customers.id, customer.id));
  } catch (error) {
    if (isUniqueViolation(error, "customers_phone_unique")) {
      return { error: "Nomor HP ini sudah terdaftar di akun lain." };
    }
    throw error;
  }

  redirect("/account");
}

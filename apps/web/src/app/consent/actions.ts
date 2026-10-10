"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { db } from "@ammari/db";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { sanitizeNextPath } from "@/lib/auth/next-path";

export async function acceptPdpConsentAction(formData: FormData): Promise<void> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login");

  const next = sanitizeNextPath(formData.get("next")?.toString());
  // Defensive only — the checkbox is `required`, so a real browser never submits without it
  // ticked. The server still never trusts that client-side guard alone.
  const consented = formData.get("consent") === "on";
  if (!consented) redirect(`/consent?next=${encodeURIComponent(next)}`);

  await db.update(customers).set({ pdpConsentAt: new Date() }).where(eq(customers.id, customer.id));
  redirect(next);
}

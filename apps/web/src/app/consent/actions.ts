"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { db } from "@ammari/db";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { COLLECTION_PATH, sanitizeNextPath } from "@/lib/auth/next-path";

export async function acceptPdpConsentAction(formData: FormData): Promise<void> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login");

  // Same fallback as the page: an explicit `next` is kept, none means the collection.
  const next = sanitizeNextPath(formData.get("next")?.toString(), COLLECTION_PATH);
  // Defensive only — the checkbox is `required`, so a real browser never submits without it
  // ticked. The server still never trusts that client-side guard alone.
  const consented = formData.get("consent") === "on";
  if (!consented) redirect(`/consent?next=${encodeURIComponent(next)}`);

  await db.update(customers).set({ pdpConsentAt: new Date() }).where(eq(customers.id, customer.id));
  redirect(next);
}

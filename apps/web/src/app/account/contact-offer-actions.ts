"use server";

import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { answerContactOffer } from "@/lib/account/contact-offer";

export interface ContactOfferState {
  error?: string;
  /** Answered: the card shows a short confirmation until the page is next loaded. */
  done?: "saved" | "skipped";
}

/** "Simpan" / "Lewati" on the /account offer (lib/account/contact-offer.ts). The number saved always
 * comes from the server's own re-read; what the browser sends (the order and number shown) only has
 * to match it. No revalidation: the card answers in place, and the next page load no longer has it. */
export async function answerContactOfferAction(_prev: ContactOfferState, formData: FormData): Promise<ContactOfferState> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login?next=%2Faccount");

  const save = formData.get("decision") === "save";
  const seenPhone = formData.get("seenPhone");
  const result = await answerContactOffer(
    customer.id,
    save
      ? { kind: "save", promo: formData.get("promo") === "on", seen: { orderNo: String(formData.get("seenOrderNo") ?? ""), phone: typeof seenPhone === "string" && seenPhone !== "" ? seenPhone : null } }
      : { kind: "skip" },
  );
  if (!result.ok) return { error: result.message };
  return { done: save ? "saved" : "skipped" };
}

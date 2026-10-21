"use server";

import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { CONTACT_OFFER_SEEN_KEY, answerContactOffer } from "@/lib/account/contact-offer";

export interface ContactOfferState {
  error?: string;
  /** Answered: the card shows a short confirmation until the page is next loaded. */
  done?: "saved" | "skipped";
}

/** "Simpan" / "Lewati" on the /account offer (lib/account/contact-offer.ts). The number and address
 * saved always come from the server's own re-read; what the browser sends (the order, number, name
 * and kind of address shown) only has to match it. No revalidation: the card answers in place, and the next page load no longer has it. */
export async function answerContactOfferAction(_prev: ContactOfferState, formData: FormData): Promise<ContactOfferState> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login?next=%2Faccount");

  const save = formData.get("decision") === "save";
  const seenPhone = formData.get("seenPhone");
  const seenName = formData.get("seenName");
  const seenAddress = formData.get("seenAddress");
  const result = await answerContactOffer(
    customer.id,
    save
      ? {
          kind: "save",
          promo: formData.get("promo") === "on",
          useName: formData.get("useName") === "on",
          useAddress: formData.get("useAddress") === "on",
          seen: {
            orderNo: String(formData.get("seenOrderNo") ?? ""),
            phone: typeof seenPhone === "string" && seenPhone !== "" ? seenPhone : null,
            name: typeof seenName === "string" && seenName !== "" ? seenName : null,
            address: typeof seenAddress === "string" && CONTACT_OFFER_SEEN_KEY.test(seenAddress) ? seenAddress : null,
          },
        }
      : { kind: "skip" },
  );
  if (!result.ok) return { error: result.message };
  return { done: save ? "saved" : "skipped" };
}

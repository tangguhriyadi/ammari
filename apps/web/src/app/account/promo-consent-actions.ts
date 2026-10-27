"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { databaseErrorLogFields } from "@ammari/commerce/checkout";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { getCartClientIp } from "@/lib/cart/ip";
import { CART_RATE_LIMITED_MESSAGE } from "@/lib/cart/messages";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { PROMO_CONSENT_FAILED_MESSAGE, PROMO_CONSENT_INVALID_MESSAGE } from "@/lib/account/promo-consent-messages";
import { PROMO_CONSENT_CHANGE_LIMIT, PROMO_CONSENT_CHANGE_WINDOW_SECONDS, setPromoConsent } from "@/lib/account/promo-consent";

export type PromoConsentResult = { ok: true } | { ok: false; message: string };

/** "Berhenti terima promo" / "Terima kabar promo" on /account (lib/account/promo-consent.ts). The
 * customer comes from the session; the browser sends only the wanted state. Next's Origin check on
 * server actions is the CSRF guard; the per-IP limit is counted before the write. Pressing it when
 * the state is already the wanted one (another tab) changes nothing and still answers ok. */
export async function setPromoConsentAction(wanted: boolean): Promise<PromoConsentResult> {
  const customer = await getCustomerSession();
  if (!customer) redirect("/login?next=%2Faccount");
  if (typeof wanted !== "boolean") return { ok: false, message: PROMO_CONSENT_INVALID_MESSAGE };
  try {
    const ip = await getCartClientIp("promo consent change");
    if (!ip) return { ok: false, message: PROMO_CONSENT_FAILED_MESSAGE };
    if ((await recordClaimAttemptAndCount(defaultDb, ip, "promo_consent_change", PROMO_CONSENT_CHANGE_WINDOW_SECONDS)) >= PROMO_CONSENT_CHANGE_LIMIT) {
      return { ok: false, message: CART_RATE_LIMITED_MESSAGE };
    }
    await setPromoConsent(customer.id, wanted);
  } catch (error) {
    console.error("[account] promo consent change failed", { customerId: customer.id, ...databaseErrorLogFields(error) });
    return { ok: false, message: PROMO_CONSENT_FAILED_MESSAGE };
  }
  // The page re-renders in the same response with the new state.
  refresh();
  return { ok: true };
}

import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { db } from "@ammari/db";
import { customerAuth } from "./customer";

export interface CustomerSessionData {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  pdpConsentAt: Date | null;
  promoConsentAt: Date | null;
}

/** Never trusts the Better Auth session payload for profile/consent state — consent
 * (`pdp_consent_at`) and profile completion (`phone`) are both written straight to `customers`,
 * not to any Better Auth table, so this re-derives them fresh from `customers` on every call.
 * Memoized per request via React's `cache()`, same pattern apps/admin's `getStaffSession` uses. */
export const getCustomerSession = cache(async (): Promise<CustomerSessionData | null> => {
  const session = await customerAuth.api.getSession({ headers: await headers() });
  const customerId = (session?.user as { customerId?: string } | undefined)?.customerId;
  if (!customerId) return null;

  const [customer] = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      phone: customers.phone,
      pdpConsentAt: customers.pdpConsentAt,
      promoConsentAt: customers.promoConsentAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  return customer ?? null;
});

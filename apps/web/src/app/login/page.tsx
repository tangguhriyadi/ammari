import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { isGoogleConfigured } from "@/lib/auth/customer";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = sanitizeNextPath(next);

  // Login itself never checks consent — it only needs to know whether there's already a
  // session at all (decided plan, option (c)): the destination page's own
  // requireConsentedSession() is what decides whether /consent still stands in the way.
  const customer = await getCustomerSession();
  if (customer) redirect(safeNext);

  return <LoginForm isGoogleConfigured={isGoogleConfigured} next={safeNext} />;
}

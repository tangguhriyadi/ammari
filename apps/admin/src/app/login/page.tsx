import { redirect } from "next/navigation";
import { getStaffSession } from "@/lib/auth/staff-session";
import { parseLoginEmailParam } from "@/lib/auth/login-email-param";
import { isGoogleConfigured } from "@/lib/auth/staff";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getStaffSession();
  if (session) redirect("/");

  const initialEmail = parseLoginEmailParam((await searchParams).email);
  return <LoginForm isGoogleConfigured={isGoogleConfigured} initialEmail={initialEmail} />;
}

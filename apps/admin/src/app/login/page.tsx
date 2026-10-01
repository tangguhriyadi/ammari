import { redirect } from "next/navigation";
import { getStaffSession } from "@/lib/auth/staff-session";
import { isGoogleConfigured } from "@/lib/auth/staff";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const session = await getStaffSession();
  if (session) redirect("/");

  return <LoginForm isGoogleConfigured={isGoogleConfigured} />;
}

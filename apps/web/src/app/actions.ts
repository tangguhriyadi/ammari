"use server";

import { redirect } from "next/navigation";
import { signOutCustomer } from "@/lib/auth/sign-out";

export async function logoutAction(): Promise<void> {
  await signOutCustomer();
  redirect("/login");
}

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { customerAuth } from "@/lib/auth/customer";

export async function logoutAction(): Promise<void> {
  await customerAuth.api.signOut({ headers: await headers() });
  redirect("/login");
}

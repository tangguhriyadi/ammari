"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { staffAuth } from "@/lib/auth/staff";

export async function logoutAction(): Promise<void> {
  await staffAuth.api.signOut({ headers: await headers() });
  redirect("/login");
}

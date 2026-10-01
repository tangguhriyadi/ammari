import { redirect } from "next/navigation";
import { getStaffSession } from "@/lib/auth/staff-session";
import { logoutAction } from "./actions";

export default async function Home() {
  const session = await getStaffSession();
  if (!session) redirect("/login");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-4 text-center">
      <h1 className="text-2xl font-semibold text-[#695A5A]">Ammari Admin</h1>
      <p className="text-black">
        Halo, <span className="font-medium">{session.staffUser.name}</span>
      </p>
      <p className="text-sm text-black/70">{session.role.name}</p>
      <form action={logoutAction}>
        <button
          type="submit"
          className="h-11 rounded-md border border-[#695A5A] px-6 text-base font-medium text-[#695A5A]"
        >
          Keluar
        </button>
      </form>
    </main>
  );
}

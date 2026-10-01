import { LogOut } from "lucide-react";
import type { StaffSessionData } from "@ammari/auth/staff";
import { logoutAction } from "@/app/actions";

export function AccountMenu({ session }: { session: StaffSessionData }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        <span className="text-base font-medium text-neutral-900">{session.staffUser.name}</span>
        <span className="text-sm text-neutral-600">{session.role.name}</span>
      </div>
      <form action={logoutAction}>
        <button
          type="submit"
          className="flex min-h-11 w-full items-center gap-2 rounded-md border border-neutral-500 px-3 text-base font-medium text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          <LogOut aria-hidden="true" className="size-4" />
          Keluar
        </button>
      </form>
    </div>
  );
}

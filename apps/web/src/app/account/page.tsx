import { Button } from "@ammari/ui";
import { requireConsentedSession } from "@/lib/auth/require-customer";
import { logoutAction } from "@/app/actions";
import { ProfileBanner } from "./profile-banner";

export default async function AccountPage() {
  const customer = await requireConsentedSession("/account");

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
      <h1 className="font-serif text-2xl font-light text-brand">Akun Saya</h1>
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-neutral-900">{customer.name}</p>
        {customer.email && <p className="text-sm text-neutral-700">{customer.email}</p>}
      </div>

      {!customer.phone && <ProfileBanner />}

      {/* Voucher list ships in session 2, once a real claim flow can create one. */}

      <form action={logoutAction}>
        <Button type="submit" variant="secondary">
          Keluar
        </Button>
      </form>
    </div>
  );
}

import { Badge, Button, EmptyState } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import { requireConsentedSession } from "@/lib/auth/require-customer";
import { listMyOrders, listMyVouchers } from "@/lib/account/queries";
import { logoutAction } from "@/app/actions";
import { ProfileBanner } from "./profile-banner";

const VOUCHER_STATUS_LABELS: Record<string, string> = {
  active: "Aktif",
  used: "Terpakai",
  expired: "Kedaluwarsa",
  void: "Dibatalkan",
};

export default async function AccountPage() {
  const customer = await requireConsentedSession("/account");
  const [myOrders, myVouchers] = await Promise.all([listMyOrders(customer.id), listMyVouchers(customer.id)]);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
      <h1 className="font-serif text-2xl font-light text-brand">Akun Saya</h1>
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-neutral-900">{customer.name}</p>
        {customer.email && <p className="text-sm text-neutral-700">{customer.email}</p>}
      </div>

      {!customer.phone && <ProfileBanner />}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">Voucher saya</h2>
        {myVouchers.length === 0 ? (
          <p className="text-sm text-neutral-600">Belum ada voucher.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {myVouchers.map((voucher) => (
              <li key={voucher.id} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3">
                <div>
                  <p className="text-base font-medium text-neutral-900">{formatRupiah(voucher.amount)}</p>
                  <p className="text-sm text-neutral-600">Berlaku sampai {formatDate(voucher.expiresAt)}</p>
                </div>
                <Badge variant={voucher.status === "active" ? "success" : "neutral"}>
                  {VOUCHER_STATUS_LABELS[voucher.status] ?? voucher.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">Pesanan saya</h2>
        {myOrders.length === 0 ? (
          <EmptyState title="Belum ada pesanan" description="Pesanan yang tertaut ke akunmu akan muncul di sini." />
        ) : (
          <ul className="flex flex-col gap-2">
            {myOrders.map((order) => (
              <li key={order.id} className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-medium text-neutral-900">{order.orderNo}</span>
                  <Badge variant="neutral">{order.channelName}</Badge>
                </div>
                <p className="text-sm text-neutral-600">{formatDate(order.orderDate)}</p>
                <p className="text-sm text-neutral-700">
                  {order.items.map((item) => `${item.productName} (${item.colorName}, ${item.size}) x${item.qty}`).join(", ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={logoutAction}>
        <Button type="submit" variant="secondary">
          Keluar
        </Button>
      </form>
    </div>
  );
}

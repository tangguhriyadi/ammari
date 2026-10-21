import Link from "next/link";
import { Badge, EmptyState } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import { requireConsentedSession } from "@/lib/auth/require-customer";
import { listMyOrders, listMyVouchers } from "@/lib/account/queries";
import { loadContactOffer } from "@/lib/account/contact-offer";
import { isCartEnabled } from "@/lib/cart-flag";
import { listCustomerOrders } from "@/lib/orders/queries";
import { OrderList } from "@/components/orders/order-list";
import { CUSTOMER_PLACEHOLDER_NAME } from "@ammari/auth/customer";
import { AccountName } from "./account-name";
import { ContactOfferCard } from "./contact-offer-card";
import { LogoutButton } from "./logout-button";
import { ProfileBanner } from "./profile-banner";

const VOUCHER_STATUS_LABELS: Record<string, string> = {
  active: "Aktif",
  used: "Terpakai",
  expired: "Kedaluwarsa",
  void: "Dibatalkan",
};

/** With the cart flag on, the account page shows the newest orders with status and total and links
 * to "Pesanan saya" (docs/plans/cart-checkout.md §9.1); with it off, the list stays as it was. */
const ACCOUNT_ORDER_PREVIEW = 5;

export default async function AccountPage() {
  const customer = await requireConsentedSession("/account");
  const cartEnabled = isCartEnabled();
  const [myOrders, orderPage, myVouchers, contactOffer] = await Promise.all([
    cartEnabled ? Promise.resolve([]) : listMyOrders(customer.id),
    cartEnabled ? listCustomerOrders(customer.id, 1, undefined, ACCOUNT_ORDER_PREVIEW) : Promise.resolve(null),
    listMyVouchers(customer.id),
    loadContactOffer(customer.id),
  ]);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
      <h1 className="font-serif text-2xl font-light text-brand">Akun Saya</h1>
      <div className="flex flex-col gap-1">
        <AccountName name={customer.name} isPlaceholder={customer.name === CUSTOMER_PLACEHOLDER_NAME} />
        {customer.email && <p className="text-sm text-neutral-700">{customer.email}</p>}
      </div>

      {contactOffer ? <ContactOfferCard {...contactOffer} /> : !customer.phone && <ProfileBanner />}

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
        {orderPage ? (
          orderPage.rows.length === 0 ? (
            <EmptyState title="Belum ada pesanan" description="Pesanan yang tertaut ke akunmu akan muncul di sini." />
          ) : (
            <>
              <OrderList rows={orderPage.rows} compact />
              <Link href="/orders" className="inline-flex min-h-[44px] items-center self-start text-sm font-medium text-brand underline underline-offset-4">
                Lihat semua pesanan
              </Link>
            </>
          )
        ) : myOrders.length === 0 ? (
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

      <LogoutButton email={customer.email ?? null} />
    </div>
  );
}

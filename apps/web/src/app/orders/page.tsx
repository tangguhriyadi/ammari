import type { Metadata } from "next";
import Link from "next/link";
import { requireConsentedSession } from "@/lib/auth/require-customer";
import { loadContactOffer } from "@/lib/account/contact-offer";
import { listCustomerOrders } from "@/lib/orders/queries";
import { Container } from "@/components/container";
import { PrimaryLink } from "@/components/buttons";
import { OrderList } from "@/components/orders/order-list";
import { ContactOfferCard } from "@/app/account/contact-offer-card";

// "Pesanan saya" (docs/plans/cart-checkout.md §9.1): every order the session may see
// (lib/orders/access.ts), newest first, paginated. Where a login by link or by the finish page's
// email login lands (plan §9.3), so the contact offer (decision 35) shows here as well as on
// /account. Works with the cart flag off too (owner decision 2026-10-21, plan §14).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pesanan saya | Ammari",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const customer = await requireConsentedSession("/orders");
  const { page: rawPage } = await searchParams;
  const requested = Number.parseInt(typeof rawPage === "string" ? rawPage : "1", 10);
  const [list, contactOffer] = await Promise.all([listCustomerOrders(customer.id, Number.isFinite(requested) ? requested : 1), loadContactOffer(customer.id)]);

  return (
    <Container className="flex max-w-[800px] flex-col gap-6 py-8 md:py-12">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-serif text-[30px] font-normal text-ink">Pesanan saya</h1>
        <Link href="/account" className="inline-flex min-h-[44px] items-center text-xs text-ink-muted underline underline-offset-4">
          Akun saya
        </Link>
      </div>

      {contactOffer && <ContactOfferCard key={contactOffer.orderNo} {...contactOffer} />}

      {list.rows.length === 0 ? (
        <div className="flex flex-col items-start gap-4 bg-surface p-6">
          <p className="text-sm text-ink">Belum ada pesanan.</p>
          <p className="text-sm text-ink-muted">Pesanan yang tertaut ke akunmu akan muncul di sini.</p>
          <PrimaryLink href="/#koleksi" className="w-full md:w-auto">
            Lihat koleksi
          </PrimaryLink>
        </div>
      ) : (
        <OrderList rows={list.rows} />
      )}

      {list.pageCount > 1 && (
        <nav aria-label="Halaman pesanan" className="flex items-center justify-between gap-4 text-sm">
          {list.page > 1 ? (
            <Link href={`/orders?page=${list.page - 1}`} className="inline-flex min-h-[44px] items-center text-ink underline underline-offset-4">
              Sebelumnya
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          <span className="text-ink-muted">
            Halaman {list.page} dari {list.pageCount}
          </span>
          {list.page < list.pageCount ? (
            <Link href={`/orders?page=${list.page + 1}`} className="inline-flex min-h-[44px] items-center text-ink underline underline-offset-4">
              Berikutnya
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
        </nav>
      )}
    </Container>
  );
}

import { PrimaryLink } from "@/components/buttons";
import { Container } from "@/components/container";
import { LOGIN_FOR_ORDERS_HREF } from "@/lib/auth/login-prefill";

// The one answer for an order this visitor may not see (docs/plans/cart-checkout.md §9.1, §9.2):
// an unknown number, someone else's order, a wrong token, or an expired "Lihat pesanan" link all
// read the same, so the page never confirms that an order exists. The way in is the email login.
export default function OrderNotFound() {
  return (
    <Container className="flex max-w-[640px] flex-col gap-6 py-8 md:py-12">
      <h1 className="font-serif text-[30px] font-normal text-ink" data-testid="order-not-found">
        Pesanan tidak bisa ditampilkan
      </h1>
      <p className="text-sm text-ink-muted">
        Link pesanan ini tidak berlaku lagi, atau pesanan ini tidak bisa dibuka dari akun atau perangkat ini. Masuk dengan email yang kamu pakai saat memesan untuk melihat pesananmu.
      </p>
      <PrimaryLink href={LOGIN_FOR_ORDERS_HREF} className="w-full md:w-auto md:self-start">
        Masuk untuk melihat pesanan
      </PrimaryLink>
    </Container>
  );
}

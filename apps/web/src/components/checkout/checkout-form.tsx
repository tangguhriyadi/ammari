"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, X } from "lucide-react";
import { cn } from "@ammari/ui";
import { PLACE_ORDER_MESSAGES } from "@ammari/commerce/checkout-messages";
import { signOutFromCheckoutAction } from "@/app/checkout/actions";
import { PrimaryLink } from "@/components/buttons";
import { Curtain } from "@/components/curtain";
import { ProductImage } from "@/components/product-image";
import { placeOrderAction, type PlaceOrderActionResult } from "@/lib/checkout/actions";
import {
  cartFingerprint,
  computeCheckoutTotals,
  validateCheckoutForm,
  type CheckoutFieldIssue,
  type CheckoutVoucherOption,
  type PickedArea,
  type SavedCheckoutAddress,
} from "@/lib/checkout/form";
import { goToPaymentPage } from "@/lib/checkout/navigate";
import { failedCallMessage } from "@/lib/stale-deployment";
import { CHECKOUT_CALL_LOST_MESSAGE, SHIPPING_QUOTE_PENDING_MESSAGE } from "@/lib/checkout/messages";
import { quoteShippingAction } from "@/lib/checkout/quote-actions";
import type { QuoteShippingActionResult } from "@/lib/checkout/quote-types";
import { announceCartCount, requestCartCountRefresh } from "@/lib/cart/count-event";
import { formatPriceIdr } from "@/lib/format";
import { buildWhatsappUrl } from "@/lib/whatsapp";
import { AreaCombobox } from "./area-combobox";
import { SectionHeading, TextAreaField, TextField } from "./fields";
import { ShippingCostRows } from "@/components/shipping-cost-rows";
import { ShippingSection, type QuoteState } from "./shipping-section";

// The checkout page's form (docs/plans/cart-checkout.md §4.3, §4.4, §4.5; docs/design/storefront.md
// §7; mockup-checkout.png): 1 Kontak, 2 Alamat pengiriman, 3 Pengiriman, 4 Ringkasan, then
// "Bayar sekarang". Every figure shown comes from the server (cart subtotal, the quote, the voucher
// amount); the browser only adds them up for display and sends the sum as `expectedTotal`, which
// placeOrder uses solely to detect drift. "Bayar sekarang" is always enabled: a submit with
// something missing shows one alert listing what to fix.
//
// After a successful order the server action re-renders this page with an empty cart (it sets
// cookies), so `placed` keeps the "opening the payment page" state up until the browser leaves.

export interface CheckoutLine {
  sku: string;
  name: string;
  /** "Beige · M". */
  variant: string;
  qty: number;
  lineTotal: number;
  imageUrl: string | null;
}

export interface CheckoutFormProps {
  /** One per page load (orders.checkout_attempt_id): a double submit answers with the same order. */
  checkoutAttemptId: string;
  cart: { lines: CheckoutLine[]; subtotal: number; pieceCount: number; canCheckout: boolean };
  /** The session customer (email from the account, locked); null for a guest. */
  customer: { email: string | null; phone: string | null; name: string } | null;
  /** Usable vouchers, best first (logged in only). */
  vouchers: CheckoutVoucherOption[];
  whatsappNumber: string | null;
  /** The logged-in buyer's saved address (their last order's), or null (guests always). */
  savedAddress?: SavedCheckoutAddress | null;
}

/** The address fields: a problem with one of them opens the form under a saved-address card. */
const ADDRESS_FIELDS = new Set(["recipientName", "phone", "shippingAreaId", "postalCode", "addressLine", "notes"]);

const COLLECTION_HREF = "/#koleksi";
const CART_HREF = "/cart";
const LOGIN_FOR_CHECKOUT_HREF = "/login?next=%2Fcheckout";
const ALERT_ID = "checkout-alert";

/** Refusals after which the summary on screen is stale: re-read the page and quote again. */
const STALE_SUMMARY_MESSAGES = new Set<string>([PLACE_ORDER_MESSAGES.total_changed, PLACE_ORDER_MESSAGES.cart_changed]);

function subscribeNever(): () => void {
  return () => {};
}

function issueFor(issues: CheckoutFieldIssue[], field: string): string | undefined {
  return issues.find((issue) => issue.field === field)?.message;
}

/** How many times in a row a quote for another cart than the one shown re-reads the page before
 * the buyer is asked to retry by hand (a cart changing again and again in another tab). */
const MAX_AUTO_REQUOTES = 2;

export function CheckoutForm({ checkoutAttemptId, cart, customer, vouchers, whatsappNumber, savedAddress = null }: CheckoutFormProps) {
  const router = useRouter();
  // `data-hydrated` on the form: e2e waits for it before typing (input typed into server HTML
  // before React takes over is not seen by the controlled fields).
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const [attemptId] = useState(checkoutAttemptId);
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState(customer?.phone ?? "");
  const [recipientName, setRecipientName] = useState(savedAddress?.recipientName ?? customer?.name ?? "");
  const [phone, setPhone] = useState(savedAddress?.phone ?? customer?.phone ?? "");
  const [area, setArea] = useState<PickedArea | null>(savedAddress?.area ?? null);
  const [postalCode, setPostalCode] = useState(savedAddress?.postalCode ?? "");
  const [addressLine, setAddressLine] = useState(savedAddress?.addressLine ?? "");
  const [notes, setNotes] = useState(savedAddress?.notes ?? "");
  // A logged-in buyer with a usable saved address sees it as a summary card; "Ganti alamat" opens
  // the normal form, prefilled (owner request 2026-10-21, plan §4.3).
  const [usingSavedAddress, setUsingSavedAddress] = useState(savedAddress?.area != null);
  const [voucherChoice, setVoucherChoice] = useState<string | null>(vouchers[0]?.id ?? null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [promoOptIn, setPromoOptIn] = useState(false);
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [issues, setIssues] = useState<CheckoutFieldIssue[]>([]);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  /** The page the browser is being sent to after a placed order; set means "placed". */
  const [placedUrl, setPlacedUrl] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [isSigningOut, startSignOut] = useTransition();
  const quoteSequence = useRef(0);
  const alertRef = useRef<HTMLDivElement>(null);
  const alertOpenRef = useRef(false);
  const focusAlertPending = useRef(false);

  // The latest render's cart and area, for async callbacks that started under an older render.
  const cartKey = cartFingerprint(cart.lines, cart.subtotal);
  const latest = useRef({ cartKey, areaId: area?.id ?? null });
  const requoteOnCartChange = useRef(false);
  const autoRequotes = useRef(0);
  useEffect(() => {
    latest.current = { cartKey, areaId: area?.id ?? null };
  });

  // A voucher used or expired elsewhere drops out of the list on the next page read; never keep
  // sending (or counting) one that is no longer offered.
  const voucher = vouchers.find((option) => option.id === voucherChoice) ?? null;
  const voucherId = voucher?.id ?? null;
  const phoneLocked = customer !== null && customer.phone !== null;
  const buyerShipping = quote.status === "ok" ? quote.quote.buyerAmount : null;
  const totals = computeCheckoutTotals(cart.subtotal, buyerShipping, voucher?.amount ?? null);

  const whatsappHref = whatsappNumber
    ? buildWhatsappUrl(whatsappNumber, area ? `Halo, saya mau pesan. Alamat pengiriman: ${area.label}.` : "Halo, saya mau pesan.")
    : null;

  function requestQuote(areaId: string) {
    const sequence = ++quoteSequence.current;
    setQuote({ status: "loading" });
    void (async () => {
      let result: QuoteShippingActionResult;
      try {
        result = await quoteShippingAction({ shippingAreaId: areaId });
      } catch (callError) {
        // The call itself failed (offline, a 5xx, a deploy changed the action ids).
        console.error("[checkout] shipping quote call failed", callError);
        result = { ok: false, kind: "retry", message: failedCallMessage(callError, PLACE_ORDER_MESSAGES.shipping_unavailable) };
      }
      // A newer pick (or "Ganti") superseded this request.
      if (sequence !== quoteSequence.current) return;
      if (!result.ok) {
        setQuote({ status: "error", kind: result.kind, message: result.message });
        return;
      }
      if (result.cartKey !== latest.current.cartKey) {
        // Quoted for other lines than the page shows (the cart changed in another tab, or the page
        // is still re-reading after a refusal): never show it. Re-read the page; the effect below
        // quotes again once the new cart has arrived.
        if (autoRequotes.current >= MAX_AUTO_REQUOTES) {
          setQuote({ status: "error", kind: "retry", message: PLACE_ORDER_MESSAGES.cart_changed });
          return;
        }
        autoRequotes.current += 1;
        requoteOnCartChange.current = true;
        router.refresh();
        return;
      }
      autoRequotes.current = 0;
      setQuote({ status: "ok", quote: result.quote });
    })();
  }

  // Quote again once a re-read page brings a different cart (see requestQuote).
  useEffect(() => {
    if (!requoteOnCartChange.current) return;
    requoteOnCartChange.current = false;
    const areaId = latest.current.areaId;
    if (areaId) requestQuote(areaId);
    // requestQuote only reads refs and setters; the cart is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);

  // The saved address's area is quoted afresh on arrival, like a pick (the quote is never stored
  // with the address; placeOrder computes it again anyway). Once per page load.
  const quotedSavedArea = useRef(false);
  useEffect(() => {
    if (quotedSavedArea.current || !savedAddress?.area) return;
    quotedSavedArea.current = true;
    requestQuote(savedAddress.area.id);
    // Once per page load; requestQuote only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function restoreSavedAddress() {
    if (!savedAddress?.area) return;
    setRecipientName(savedAddress.recipientName);
    setPhone(savedAddress.phone);
    setAddressLine(savedAddress.addressLine);
    setNotes(savedAddress.notes);
    setIssues((current) => current.filter((issue) => !ADDRESS_FIELDS.has(issue.field)));
    if (area?.id !== savedAddress.area.id) handleAreaChange(savedAddress.area);
    setPostalCode(savedAddress.postalCode);
    setUsingSavedAddress(true);
    // The button that was pressed is gone: focus goes to the card's own "Ganti alamat".
    requestAnimationFrame(() => document.getElementById("saved-address-change")?.focus());
  }

  function changeSavedAddress() {
    setUsingSavedAddress(false);
    // The card is gone: focus goes to the first field of the form that replaced it.
    requestAnimationFrame(() => document.getElementById("recipientName")?.focus());
  }

  function handleAreaChange(next: PickedArea | null) {
    setArea(next);
    // A kode pos typed for one area never carries over to another.
    setPostalCode("");
    setIssues((current) => current.filter((issue) => issue.field !== "shippingAreaId" && issue.field !== "postalCode"));
    autoRequotes.current = 0;
    if (next) {
      requestQuote(next.id);
    } else {
      quoteSequence.current += 1;
      setQuote({ status: "idle" });
    }
  }

  function focusAlertIfPending() {
    if (!focusAlertPending.current) return;
    focusAlertPending.current = false;
    alertRef.current?.focus();
  }

  /** Shows the one alert and moves focus to it: through the Curtain's onOpened when it is just
   * unrolling (an unrolling Curtain is inert), right after this render when it is already open.
   * The alert is never cleared while a submit is in flight, so "already open" stays true. */
  function showProblems(message: string, found: CheckoutFieldIssue[]) {
    const alreadyOpen = alertOpenRef.current;
    alertOpenRef.current = true;
    setIssues(found);
    setAlertMessage(message);
    focusAlertPending.current = true;
    if (alreadyOpen) requestAnimationFrame(focusAlertIfPending);
  }

  function shippingProblem(): string | null {
    if (!area) return null; // The area field's own error already says "Pilih kecamatan dari daftar."
    if (quote.status === "loading") return SHIPPING_QUOTE_PENDING_MESSAGE;
    if (quote.status === "error") return quote.message;
    return null;
  }

  // Back from the payment page out of the back/forward cache: the page is live again, so leave
  // the "opening the payment page" state and re-read the cart.
  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (!event.persisted) return;
      setPlacedUrl(null);
      router.refresh();
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [router]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || placedUrl) return;

    const found = validateCheckoutForm(
      { contactEmail, contactPhone, recipientName, phone, addressLine, notes, postalCode, area, termsAccepted },
      { emailLocked: customer !== null },
    );
    const shipping = shippingProblem();
    if (shipping) found.push({ field: "shipping", message: shipping });
    // A saved address that no longer passes (a rule changed since): open the form so the fields show.
    if (found.some((issue) => ADDRESS_FIELDS.has(issue.field))) setUsingSavedAddress(false);
    if (found.length > 0 || !area || quote.status !== "ok") {
      showProblems("Periksa lagi data berikut:", found);
      return;
    }

    const submittedAreaId = area.id;
    const cartSkus = new Set(cart.lines.map((line) => line.sku));
    startSubmit(async () => {
      let result: PlaceOrderActionResult;
      try {
        result = await placeOrderAction({
          checkoutAttemptId: attemptId,
          contact: { email: customer ? undefined : contactEmail, phone: contactPhone },
          address: { recipientName, phone, addressLine, notes, postalCode: area.hasPostalCode ? undefined : postalCode },
          shippingAreaId: submittedAreaId,
          voucherId: customer ? voucherId : null,
          termsAccepted,
          promoOptIn,
          expectedTotal: totals.total,
        });
      } catch (callError) {
        // The answer was lost, not necessarily the order: pressing again repeats the same attempt
        // id, which answers with the order if it was placed (plan §5), never a second one.
        console.error("[checkout] place order call failed", { attempt: attemptId, error: callError instanceof Error ? callError.name : typeof callError });
        // A page from the previous build: the action never ran, so nothing was ordered; the page
        // reloads itself (lib/stale-deployment.ts).
        showProblems(failedCallMessage(callError, CHECKOUT_CALL_LOST_MESSAGE), []);
        return;
      }

      if (result.ok) {
        const finishUrl = `/checkout/finish?order=${encodeURIComponent(result.orderNo)}`;
        const url = result.redirectUrl ?? finishUrl;
        // The order emptied the cart.
        announceCartCount(0);
        if (goToPaymentPage(url)) {
          setPlacedUrl(url);
        } else {
          // A payment URL we will not open: the finish page offers the stored one again later.
          setPlacedUrl(finishUrl);
          router.push(finishUrl);
        }
        return;
      }

      showProblems(result.message, result.fieldErrors);
      if (result.fieldErrors.some((issue) => ADDRESS_FIELDS.has(issue.field))) setUsingSavedAddress(false);
      // The buyer picked another area while this submit ran: its own quote stands.
      if (latest.current.areaId !== submittedAreaId) return;
      const shippingKind =
        result.message === PLACE_ORDER_MESSAGES.shipping_unavailable
          ? "retry"
          : result.message === PLACE_ORDER_MESSAGES.shipping_no_service
            ? "no_service"
            : result.message === PLACE_ORDER_MESSAGES.shipping_missing_weight
              ? "missing_weight"
              : null;
      if (shippingKind) {
        quoteSequence.current += 1;
        setQuote({ status: "error", kind: shippingKind, message: result.message });
      } else if (STALE_SUMMARY_MESSAGES.has(result.message) || result.fieldErrors.some((issue) => cartSkus.has(issue.field))) {
        // A price, the ongkir, a voucher, the lines or the stock changed (a short-stock refusal is
        // keyed by the line's SKU): re-read the page and the quote. The re-read can swap the form
        // for the "check your cart" notice, which mounts the alert again: focus it there too.
        focusAlertPending.current = true;
        autoRequotes.current = 0;
        router.refresh();
        requestQuote(submittedAreaId);
      }
    });
  }

  // The one alert (plan §4.3), unrolled with the Curtain. Rendered above the form and above the
  // "check your cart" notice alike, so a refusal that also changed the cart (stock ran out) stays
  // readable after the page re-reads it.
  const alertBlock = (
    <Curtain open={alertMessage !== null} onOpened={focusAlertIfPending}>
      <div
        ref={alertRef}
        id={ALERT_ID}
        role="alert"
        tabIndex={-1}
        className="flex flex-col gap-2 border border-error-border px-4 py-3 text-sm text-error outline-none"
        data-testid="checkout-alert"
      >
        {alertMessage && <p className="font-medium">{alertMessage}</p>}
        {issues.length > 0 && (
          <ul className="list-disc pl-5">
            {issues.map((issue, index) => (
              <li key={`${issue.field}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        )}
      </div>
    </Curtain>
  );

  // Placed (or the successful submit's re-render already brought the emptied cart): never flash
  // "Keranjangmu masih kosong" while the browser leaves for the payment page.
  if (placedUrl || (isSubmitting && cart.lines.length === 0)) {
    return (
      <div className="flex flex-col items-start gap-4 py-10">
        <p role="status" className="text-sm text-ink">
          Pesanan dibuat. Membuka halaman pembayaran...
        </p>
        {placedUrl && (
          <a href={placedUrl} className="text-xs font-medium tracking-[0.16em] text-ink uppercase underline underline-offset-4">
            Buka halaman pembayaran
          </a>
        )}
      </div>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-6 py-10">
        <p className="text-sm text-ink-muted">Keranjangmu masih kosong.</p>
        <PrimaryLink href={COLLECTION_HREF} className="w-full md:w-auto">
          Lihat koleksi
        </PrimaryLink>
      </div>
    );
  }

  if (!cart.canCheckout) {
    return (
      <div className="flex flex-col items-start gap-6 py-10">
        <div className="w-full">{alertBlock}</div>
        <p className="text-sm text-ink">Ada barang di keranjang yang perlu dicek dulu sebelum checkout.</p>
        <PrimaryLink href={CART_HREF} className="w-full md:w-auto">
          Kembali ke keranjang
        </PrimaryLink>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit} aria-busy={isSubmitting || undefined} data-hydrated={hydrated || undefined} className="mt-6 flex flex-col gap-8 md:grid md:grid-cols-[minmax(0,1fr)_380px] md:items-start md:gap-10 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex flex-col gap-10">
        {alertBlock}

        {/* 1 · Kontak */}
        <section aria-labelledby="checkout-contact" className="flex flex-col gap-4">
          <SectionHeading id="checkout-contact" number={1}>
            Kontak
          </SectionHeading>
          {customer ? (
            <div className="flex flex-col gap-4 bg-surface px-4 py-4">
              <dl className="flex flex-col gap-3 text-sm">
                <div className="flex flex-col pl-7">
                  <dt className="text-xs text-ink-muted">Email</dt>
                  <dd className="relative text-ink" data-testid="locked-email">
                    <Lock aria-hidden="true" className="absolute top-0.5 -left-7 size-4 text-ink-muted" strokeWidth={1.4} />
                    {customer.email}
                  </dd>
                </div>
                {phoneLocked && (
                  <div className="flex flex-col pl-7">
                    <dt className="text-xs text-ink-muted">Nomor HP (WhatsApp)</dt>
                    <dd className="relative text-ink">
                      <Lock aria-hidden="true" className="absolute top-0.5 -left-7 size-4 text-ink-muted" strokeWidth={1.4} />
                      {customer.phone}
                    </dd>
                  </div>
                )}
              </dl>
              <div className="flex items-center justify-between gap-4 text-xs text-ink-muted">
                <span>Terhubung dengan akunmu.</span>
                <button
                  type="button"
                  onClick={() => {
                    if (isSigningOut) return;
                    // The header bag empties at once; a failed logout has it re-read the real count.
                    announceCartCount(0);
                    startSignOut(async () => {
                      try {
                        await signOutFromCheckoutAction();
                      } catch (error) {
                        requestCartCountRefresh();
                        throw error;
                      }
                    });
                  }}
                  aria-disabled={isSigningOut || undefined}
                  className="min-h-11 text-ink underline underline-offset-4"
                >
                  Bukan kamu? Keluar
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">
              Sudah punya akun?{" "}
              <Link href={LOGIN_FOR_CHECKOUT_HREF} className="text-ink underline underline-offset-4">
                Masuk
              </Link>
            </p>
          )}
          {!customer && (
            <TextField
              id="contactEmail"
              label="Email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
              maxLength={254}
              error={issueFor(issues, "contactEmail")}
            />
          )}
          {!phoneLocked && (
            <TextField
              id="contactPhone"
              label="Nomor WhatsApp"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              hint="Untuk kabar pesanan. Contoh: 0812 3456 7890."
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              maxLength={40}
              error={issueFor(issues, "contactPhone")}
            />
          )}
        </section>

        {/* 2 · Alamat pengiriman */}
        <section aria-labelledby="checkout-address" className="flex flex-col gap-4">
          <SectionHeading id="checkout-address" number={2}>
            Alamat pengiriman
          </SectionHeading>
          {usingSavedAddress && area ? (
            <div className="flex flex-col gap-3 bg-surface px-4 py-4" data-testid="saved-address">
              <div className="flex flex-col gap-1 text-sm text-ink">
                <p className="font-medium">{recipientName}</p>
                <p className="text-ink-muted">{phone}</p>
                <p>{addressLine}</p>
                <p>
                  {area.label}
                  {!area.hasPostalCode && postalCode ? ` ${postalCode}` : ""}
                </p>
                {notes.trim() && <p className="text-xs text-ink-muted">Catatan untuk kurir: {notes}</p>}
              </div>
              <div className="flex items-center justify-between gap-4 text-xs text-ink-muted">
                <span>Alamat dari pesanan terakhirmu.</span>
                <button id="saved-address-change" type="button" onClick={changeSavedAddress} className="min-h-11 text-ink underline underline-offset-4">
                  Ganti alamat
                </button>
              </div>
            </div>
          ) : (
            <>
              {savedAddress?.area && (
                <button type="button" onClick={restoreSavedAddress} className="min-h-11 self-start text-xs text-ink underline underline-offset-4">
                  Pakai alamat tersimpan
                </button>
              )}
            <TextField
              id="recipientName"
              label="Nama penerima"
              autoComplete="shipping name"
              value={recipientName}
              onChange={(event) => setRecipientName(event.target.value)}
              maxLength={100}
              error={issueFor(issues, "recipientName")}
            />
            <TextField
              id="phone"
              label="Nomor HP penerima"
              type="tel"
              inputMode="tel"
              autoComplete="shipping tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={40}
              error={issueFor(issues, "phone")}
            />
            <AreaCombobox id="shippingAreaId" value={area} onChange={handleAreaChange} error={issueFor(issues, "shippingAreaId")} />
            {area && !area.hasPostalCode && (
              <TextField
                id="postalCode"
                label="Kode pos"
                inputMode="numeric"
                autoComplete="shipping postal-code"
                value={postalCode}
                onChange={(event) => setPostalCode(event.target.value)}
                maxLength={10}
                error={issueFor(issues, "postalCode")}
              />
            )}
            <TextAreaField
              id="addressLine"
              label="Alamat lengkap"
              hint="Jalan, nomor rumah, RT/RW, kelurahan"
              autoComplete="shipping street-address"
              rows={3}
              value={addressLine}
              onChange={(event) => setAddressLine(event.target.value)}
              maxLength={500}
              error={issueFor(issues, "addressLine")}
            />
            <TextField
              id="notes"
              label="Catatan untuk kurir"
              optional
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={200}
              error={issueFor(issues, "notes")}
            />
            </>
          )}
        </section>

        {/* 3 · Pengiriman */}
        <section aria-labelledby="checkout-shipping" className="flex flex-col gap-4">
          <SectionHeading id="checkout-shipping" number={3}>
            Pengiriman
          </SectionHeading>
          <ShippingSection state={quote} onRetry={() => area && requestQuote(area.id)} whatsappHref={whatsappHref} cartHref={CART_HREF} />
        </section>
      </div>

      {/* 4 · Ringkasan */}
      <section aria-labelledby="checkout-summary" className="-mx-4 flex flex-col gap-5 bg-surface px-4 py-6 md:sticky md:top-20 md:mx-0 md:p-6">
        <SectionHeading id="checkout-summary" number={4}>
          Ringkasan
        </SectionHeading>
        <ul aria-label="Barang di pesanan" className="flex flex-col gap-4">
          {cart.lines.map((line) => (
            <li key={line.sku} className="flex items-center gap-4" data-testid="checkout-line">
              <div className="relative h-[96px] w-[64px] shrink-0 bg-image-bg">
                <ProductImage src={line.imageUrl} alt="" placeholderAlt="" placeholderSize={800} sizes="64px" className="object-cover" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                <p className="text-ink">{line.name}</p>
                <p className="text-xs text-ink-muted">
                  {line.variant} · {line.qty}×
                </p>
              </div>
              <p className="shrink-0 text-sm text-ink">{formatPriceIdr(line.lineTotal)}</p>
            </li>
          ))}
        </ul>

        <VoucherField customer={customer !== null} vouchers={vouchers} voucherId={voucherId} onChange={setVoucherChoice} error={issueFor(issues, "voucherId")} />

        <dl className="flex flex-col gap-2 border-t border-line pt-4 text-sm text-ink">
          <div className="flex items-center justify-between gap-4">
            <dt>Subtotal</dt>
            <dd data-testid="summary-subtotal">{formatPriceIdr(cart.subtotal)}</dd>
          </div>
          <ShippingCostRows
            buyerAmount={buyerShipping}
            costAmount={quote.status === "ok" ? quote.quote.costAmount : null}
            subsidyAmount={quote.status === "ok" ? quote.quote.subsidyAmount : null}
            testIdPrefix="summary"
            onSurface
          />
          {totals.discount > 0 && (
            <div className="flex items-center justify-between gap-4">
              <dt>Voucher</dt>
              <dd data-testid="summary-voucher">-{formatPriceIdr(totals.discount)}</dd>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between gap-4 border-t border-line pt-3 text-base font-medium">
            <dt>Total</dt>
            <dd data-testid="summary-total">{formatPriceIdr(totals.total)}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-1">
          <ConsentCheckbox
            id="termsAccepted"
            checked={termsAccepted}
            onChange={setTermsAccepted}
            error={issueFor(issues, "termsAccepted")}
            label={
              <>
                Saya setuju dengan{" "}
                <Link href="/terms-of-service" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" onClick={(event) => event.stopPropagation()}>
                  Syarat &amp; ketentuan
                </Link>{" "}
                dan{" "}
                <Link href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" onClick={(event) => event.stopPropagation()}>
                  Kebijakan privasi
                </Link>{" "}
                Ammari.
              </>
            }
          />
          <ConsentCheckbox id="promoOptIn" checked={promoOptIn} onChange={setPromoOptIn} label="Kirimi saya kabar koleksi baru dan promo dari Ammari." />
        </div>

        <button
          type="submit"
          aria-disabled={isSubmitting || undefined}
          className={cn(
            "inline-flex min-h-[54px] w-full items-center justify-center px-6 text-xs font-medium tracking-[0.2em] text-ink uppercase transition-colors duration-150",
            "bg-pay hover:brightness-95",
            isSubmitting && "cursor-progress",
          )}
        >
          {isSubmitting ? "Memproses..." : "Bayar sekarang"}
        </button>
        <p className="text-center text-xs text-ink-muted">Metode pembayaran dipilih di langkah berikutnya: QRIS, virtual account, atau e-wallet.</p>
      </section>
    </form>
  );
}

function ConsentCheckbox({
  id,
  checked,
  onChange,
  label,
  error,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  error?: string;
}) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-[13px] leading-relaxed text-ink">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          className="mt-0.5 size-5 shrink-0 accent-ink"
        />
        <span>{label}</span>
      </label>
      {error && (
        <p id={errorId} className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

function VoucherField({
  customer,
  vouchers,
  voucherId,
  onChange,
  error,
}: {
  customer: boolean;
  vouchers: CheckoutVoucherOption[];
  voucherId: string | null;
  onChange: (id: string | null) => void;
  error?: string;
}) {
  if (!customer) {
    return (
      <Link
        href={LOGIN_FOR_CHECKOUT_HREF}
        className="flex min-h-11 items-center justify-center border border-ink bg-bg px-4 text-xs font-medium tracking-[0.16em] text-ink uppercase"
      >
        Masuk untuk pakai voucher
      </Link>
    );
  }
  if (vouchers.length === 0) return <p className="text-xs text-ink-muted">Belum ada voucher yang bisa dipakai.</p>;

  const errorId = error ? "voucherId-error" : undefined;
  return (
    <div className="flex flex-col gap-1.5 bg-bg p-4">
      <label htmlFor="voucherId" className="text-[13px] font-medium text-ink">
        Voucher
      </label>
      <div className="flex items-stretch gap-2">
        <select
          id="voucherId"
          value={voucherId ?? ""}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          className="min-h-12 min-w-0 flex-1 border border-line-strong bg-bg px-3 text-sm text-ink"
        >
          <option value="">Tanpa voucher</option>
          {vouchers.map((option) => (
            <option key={option.id} value={option.id}>
              {`Voucher ${formatPriceIdr(option.amount)}, berlaku sampai ${option.expiresOn}`}
            </option>
          ))}
        </select>
        {voucherId && (
          <button type="button" onClick={() => onChange(null)} aria-label="Hapus voucher" className="flex min-h-12 min-w-12 items-center justify-center border border-line-strong">
            <X aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </button>
        )}
      </div>
      {error && (
        <p id={errorId} className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { Button, Card } from "@ammari/ui";
import { formatDate } from "@ammari/ui/lib";
import { failedCallMessage } from "@/lib/stale-deployment";
import { PROMO_CONSENT_FAILED_MESSAGE, PROMO_CONSENT_TEXT } from "@/lib/account/promo-consent-messages";
import { setPromoConsentAction } from "./promo-consent-actions";

/** "Kabar promo" on /account (docs/plans/growth.md owner answer A11): stop promo messages in one
 * press, or start them again. No confirm dialog either way: both are one press to undo, and the
 * privacy policy promises withdrawal any time without friction. The action refreshes the page, so
 * `consentAt` arrives with the new state; the status line confirms what changed. */
export function PromoConsentSection({ consentAt }: { consentAt: Date | null }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const subscribed = consentAt !== null;

  const change = (wanted: boolean) => {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await setPromoConsentAction(wanted);
        if (result.ok) setStatus(wanted ? "Kamu akan menerima kabar promo dari Ammari." : "Kamu tidak akan menerima kabar promo lagi.");
        else setError(result.message);
      } catch (caught) {
        console.warn("[account] promo consent change did not answer", caught instanceof Error ? caught.name : typeof caught);
        setError(failedCallMessage(caught, PROMO_CONSENT_FAILED_MESSAGE));
      }
    });
  };

  return (
    <section className="flex flex-col gap-3" data-testid="account-promo" aria-labelledby="promo-consent-heading">
      <h2 id="promo-consent-heading" className="text-lg font-semibold text-neutral-900">
        Kabar promo
      </h2>
      <Card className="flex flex-col gap-3">
        <p className="text-sm text-neutral-700" data-testid="account-promo-state">
          {subscribed
            ? `Kamu menerima kabar koleksi baru dan promo dari Ammari lewat email atau WhatsApp sejak ${formatDate(consentAt)}.`
            : "Kamu tidak menerima kabar promo dari Ammari. Info pesanan dan pengiriman tetap dikirim."}
        </p>
        {/* Always mounted, so screen readers announce the text when it arrives. */}
        <p role="status" aria-live="polite" className="text-sm text-neutral-700 empty:hidden">
          {status ?? ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        )}
        {!subscribed && <p className="text-sm text-neutral-700">{PROMO_CONSENT_TEXT}</p>}
        {/* One button whose label changes, so focus stays on it after the page refreshes. */}
        <Button variant="secondary" className="self-start" loading={pending} onClick={() => change(!subscribed)}>
          {subscribed ? "Berhenti terima promo" : "Terima kabar promo"}
        </Button>
      </Card>
    </section>
  );
}

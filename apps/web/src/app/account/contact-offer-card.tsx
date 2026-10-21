"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button, Card, Checkbox } from "@ammari/ui";
import { formatDate } from "@ammari/ui/lib";
import { answerContactOfferAction, type ContactOfferState } from "./contact-offer-actions";

const initialState: ContactOfferState = {};

/** The offer to keep what a guest order recorded (docs/plans/cart-checkout.md §9.3, session 14):
 * the WhatsApp number typed at checkout and, only when ticked here again, promo consent; since the
 * 2026-10-21 sandbox run also the order's recipient name while the account has the placeholder name
 * (ticked by default, saved only with "Simpan"). Anyone can type someone's email at checkout, so
 * the card asks whether the number is the buyer's own. */
export function ContactOfferCard({ orderNo, orderDate, phone, promo, name }: { orderNo: string; orderDate: Date; phone: string | null; promo: boolean; name: string | null }) {
  const [state, formAction, pending] = useActionState(answerContactOfferAction, initialState);
  const [promoTicked, setPromoTicked] = useState(false);
  const [nameTicked, setNameTicked] = useState(true);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // The buttons disappear once answered: focus moves to the confirmation so it is not lost.
  useEffect(() => {
    if (state.done) statusRef.current?.focus();
  }, [state.done]);

  if (state.done) {
    return (
      <Card>
        <p ref={statusRef} tabIndex={-1} role="status" className="text-sm text-neutral-700 focus:outline-none">
          {state.done === "saved" ? "Tersimpan di akunmu." : "Baik, data pesanan tidak disimpan ke akun."}
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-neutral-900">Simpan data dari pesananmu?</h2>
      {phone ? (
        <p className="text-sm text-neutral-700">
          Pesanan {orderNo} ({formatDate(orderDate)}) memakai nomor WhatsApp <span className="font-medium text-neutral-900">{phone}</span>. Kalau ini
          nomormu, simpan ke akun supaya kami mudah menghubungimu.
        </p>
      ) : promo ? (
        <p className="text-sm text-neutral-700">
          Saat memesan {orderNo} ({formatDate(orderDate)}), kamu memilih menerima kabar dari Ammari.
        </p>
      ) : (
        <p className="text-sm text-neutral-700">
          Pesanan {orderNo} ({formatDate(orderDate)}) memakai nama penerima <span className="font-medium text-neutral-900">{name}</span>.
        </p>
      )}
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="seenOrderNo" value={orderNo} />
        <input type="hidden" name="seenPhone" value={phone ?? ""} />
        <input type="hidden" name="seenName" value={name ?? ""} />
        {name && (
          <Checkbox
            name="useName"
            checked={nameTicked}
            onChange={(event) => setNameTicked(event.target.checked)}
            label={`Pakai nama "${name}" sebagai nama akun.`}
          />
        )}
        {promo && (
          <Checkbox
            name="promo"
            checked={promoTicked}
            onChange={(event) => setPromoTicked(event.target.checked)}
            label="Kirimi saya kabar koleksi baru dan promo dari Ammari."
          />
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger-700">
            {state.error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" name="decision" value="save" loading={pending}>
            Simpan
          </Button>
          <Button type="submit" name="decision" value="skip" variant="ghost" disabled={pending}>
            Lewati
          </Button>
        </div>
      </form>
    </Card>
  );
}

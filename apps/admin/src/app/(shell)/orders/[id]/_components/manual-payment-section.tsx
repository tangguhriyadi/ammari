"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, useToast } from "@ammari/ui";
import type { ManualPaymentOptions } from "@/lib/orders/manual-payment-input";
import { recordManualOrderPaymentAction } from "../../actions";
import { emptyManualPaymentDraft, ManualPaymentFields, manualPaymentFromDraft, type ManualPaymentDraft } from "../../_components/manual-payment-fields";
import { DetailList, DetailRow, Note, SectionCard } from "./section-card";

// "Pembayaran" of a manual order (D-3, docs/plans/accounting.md Session 6): how and into which Kas &
// Bank account the money came, and when. An order paid before this record existed shows "Belum
// dicatat" and an "Isi cara bayar" form; until it is filled the order is a posting issue in the
// books (never a guessed account).

export interface ManualPaymentDisplay {
  methodLabel: string;
  /** Null for a viewer who may not see Kas & Bank account names (orders.view only). */
  accountName: string | null;
  paidOnLabel: string;
  recordedLabel: string;
}

export function ManualPaymentSection({
  orderId,
  required,
  awaitingPayment,
  payment,
  savedDraft,
  canManage,
  options,
  today,
  className = "",
}: {
  orderId: string;
  required: boolean;
  awaitingPayment: boolean;
  payment: ManualPaymentDisplay | null;
  /** The saved record as form values; only sent to staff who may edit it. */
  savedDraft: ManualPaymentDraft | null;
  canManage: boolean;
  options: ManualPaymentOptions;
  today: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ManualPaymentDraft>(() => savedDraft ?? emptyManualPaymentDraft());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    const input = manualPaymentFromDraft(draft, today);
    if (!input.ok) {
      setError(input.error);
      return;
    }
    startTransition(async () => {
      const result = await recordManualOrderPaymentAction({ orderId, payment: input.payment });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Cara bayar tersimpan");
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <SectionCard title="Pembayaran" testId="manual-payment-section" className={className}>
      {payment ? (
        <DetailList>
          <DetailRow label="Cara bayar" value={payment.methodLabel} testId="manual-payment-method" />
          {payment.accountName !== null && <DetailRow label="Uang masuk ke" value={payment.accountName} testId="manual-payment-account" />}
          <DetailRow label="Tanggal bayar" value={payment.paidOnLabel} testId="manual-payment-date" />
          <DetailRow label="Dicatat" value={payment.recordedLabel} />
        </DetailList>
      ) : awaitingPayment ? (
        <Note>Cara bayar dicatat saat pesanan ditandai Siap Kirim.</Note>
      ) : required ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning" className="whitespace-nowrap">
            Belum dicatat
          </Badge>
          <Note>Pesanan ini sudah dibayar tetapi cara bayar dan rekening tujuannya belum dicatat, jadi belum bisa dibukukan.</Note>
        </div>
      ) : (
        <Note>Pesanan dibatalkan sebelum dibayar, tidak ada pembayaran.</Note>
      )}

      {canManage && required && !editing && (
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              // Always start from what is saved now (a discarded edit, or a newer save after a
              // refresh, never lingers). An older order's date is never assumed: staff type it from
              // the transfer or the note.
              setDraft(savedDraft ?? emptyManualPaymentDraft());
              setError(null);
              setEditing(true);
            }}
          >
            {payment ? "Ubah cara bayar" : "Isi cara bayar"}
          </Button>
        </div>
      )}

      {canManage && editing && (
        <form
          className="flex flex-col gap-3"
          aria-label="Ubah pembayaran"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <ManualPaymentFields
            idPrefix="record-payment"
            value={draft}
            onChange={setDraft}
            options={options}
            maxDate={today}
            layout="stack"
            disabled={pending}
            autoFocus
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Batal
            </Button>
            <Button type="submit" loading={pending}>
              Simpan cara bayar
            </Button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
    </SectionCard>
  );
}

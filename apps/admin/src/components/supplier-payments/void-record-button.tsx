"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Label, Textarea, useToast } from "@ammari/ui";
import type { ActionResult } from "@/lib/action-result";

// "Batalkan" for a payment or a nota (docs/plans/purchase-payments.md P6): a required reason,
// confirmed in the admin dialog. Nothing is deleted: the row stays in the history as
// "Dibatalkan" and stops counting. The server voids it once (conditional UPDATE).

const COPY = {
  payment: {
    button: "Batalkan",
    title: (label: string) => `Batalkan pembayaran ${label}?`,
    description: "Pembayaran tetap tercatat di riwayat sebagai Dibatalkan dan tidak dihitung lagi. Tidak bisa diulang.",
    confirm: "Batalkan pembayaran",
    done: (label: string) => `Pembayaran ${label} dibatalkan`,
  },
  attachment: {
    button: "Batalkan",
    title: () => "Batalkan nota ini?",
    description: "Nota tetap tercatat di riwayat sebagai Dibatalkan. Tidak bisa diulang.",
    confirm: "Batalkan nota",
    done: () => "Nota dibatalkan",
  },
} as const;

export function VoidRecordButton({
  kind,
  id,
  label,
  voidAction,
}: {
  kind: "payment" | "attachment";
  id: string;
  label: string;
  /** voidSupplierPaymentAction for a payment, the purchase's voidPurchaseAttachmentAction for a nota. */
  voidAction: (input: { id: string; reason: string }) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const copy = COPY[kind];
  // useId, not the record id: the phone card list and the desktop table both render this button
  // for the same record, and two textareas sharing one id would point the label at the wrong one.
  const reasonId = useId();

  function handleConfirm() {
    setError(null);
    if (reason.trim() === "") {
      setError("Alasan pembatalan wajib diisi.");
      return;
    }
    startTransition(async () => {
      const result = await voidAction({ id, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(copy.done(label));
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={kind === "payment" ? `Batalkan pembayaran ${label}` : `Batalkan nota ${label}`}
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        {copy.button}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={copy.title(label)}
        description={copy.description}
        confirmLabel={copy.confirm}
        confirmVariant="danger"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <Label htmlFor={reasonId} required>
          Alasan pembatalan
        </Label>
        <Textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
        {error && (
          <p role="alert" className="mt-2 text-base text-danger-700">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}

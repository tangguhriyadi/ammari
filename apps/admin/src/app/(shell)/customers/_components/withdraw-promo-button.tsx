"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Label, Select, Textarea, useToast } from "@ammari/ui";
import { MAX_WITHDRAWAL_NOTE_LENGTH, PROMO_WITHDRAWAL_SOURCES, PROMO_WITHDRAWAL_SOURCE_LABELS, isPromoWithdrawalSource, type PromoWithdrawalSource } from "@/lib/customers/consent-options";
import { withdrawPromoConsentAction } from "../actions";

// "Catat penarikan persetujuan promo" (docs/plans/growth.md §8.3): shown only to customers.manage
// while the customer's promo consent is set. The server re-checks both.

export function WithdrawPromoButton({ customerId }: { customerId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<PromoWithdrawalSource | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sourceId = useId();
  const noteId = useId();

  function handleConfirm() {
    setError(null);
    if (source === "") {
      setError("Pilih sumber permintaan.");
      return;
    }
    if (source === "other" && note.trim() === "") {
      setError("Untuk sumber Lainnya, tulis catatan.");
      return;
    }
    startTransition(async () => {
      const result = await withdrawPromoConsentAction({ customerId, source, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success("Penarikan persetujuan promo dicatat");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setSource("");
          setNote("");
          setError(null);
          setOpen(true);
        }}
      >
        Catat penarikan persetujuan promo
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Pelanggan minta berhenti menerima promo"
        description="Persetujuan promo dihapus dan pelanggan tidak dikirimi promo lagi. Pelanggan bisa setuju lagi sendiri saat checkout."
        confirmLabel="Catat penarikan"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={sourceId} required>
              Sumber permintaan
            </Label>
            <Select id={sourceId} value={source} onChange={(event) => setSource(isPromoWithdrawalSource(event.target.value) ? event.target.value : "")}>
              <option value="">Pilih sumber</option>
              {PROMO_WITHDRAWAL_SOURCES.map((option) => (
                <option key={option} value={option}>
                  {PROMO_WITHDRAWAL_SOURCE_LABELS[option]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={noteId} required={source === "other"}>
              Catatan
            </Label>
            <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={MAX_WITHDRAWAL_NOTE_LENGTH} />
            <p className="text-sm text-neutral-600">Jangan tulis nomor HP atau email di sini.</p>
          </div>
          {error && (
            <p role="alert" className="text-base text-danger-700">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

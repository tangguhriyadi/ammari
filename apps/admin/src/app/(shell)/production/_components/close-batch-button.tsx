"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Label, Textarea, useToast } from "@ammari/ui";
import { closeBatchAction } from "../actions";

/** "Tutup batch" (inventory.manage, D19/D27): short-close a posted batch whose remaining output
 * will never arrive, with a required reason. Moves no stock and changes no cost. */
export function CloseBatchButton({ batchId, outstandingPcs }: { batchId: string; outstandingPcs: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    if (reason.trim() === "") {
      setError("Alasan wajib diisi.");
      return;
    }
    startTransition(async () => {
      const result = await closeBatchAction({ batchId, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success("Batch ditutup");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        Tutup batch
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Tutup batch ini?"
        description={`Sisa ${outstandingPcs} pcs yang belum diterima tidak akan ditunggu lagi. Hasil yang sudah diterima tetap di stok, dan HPP per pcs tidak berubah.`}
        confirmLabel="Tutup batch"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <Label htmlFor="close-batch-reason" required>
          Alasan
        </Label>
        <Textarea
          id="close-batch-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          aria-invalid={error !== null}
          aria-describedby={error ? "close-batch-reason-error" : undefined}
        />
        {error && (
          <p id="close-batch-reason-error" role="alert" className="mt-2 text-base text-danger-700">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}

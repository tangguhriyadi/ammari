"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, useToast } from "@ammari/ui";
import { reverseReceiptAction } from "../actions";

const DEFAULT_DESCRIPTION =
  "Stok dan nilai yang masuk dari penerimaan ini akan dibalik. Hanya bisa dilakukan jika barangnya belum dipakai atau disesuaikan sesudahnya.";

/** "Batalkan penerimaan" (inventory.manage, D8): writes an exact reversing receipt; never edits.
 * Shared by purchase and production-batch receipts — the server action dispatches on the
 * receipt's own source; `description` lets each page say which follow-up blocks a reversal. */
export function ReverseReceiptButton({
  receiptId,
  receiptNo,
  description = DEFAULT_DESCRIPTION,
}: {
  receiptId: string;
  receiptNo: string;
  description?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await reverseReceiptAction({ receiptId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(`Penerimaan ${receiptNo} dibatalkan`);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-label={`Batalkan penerimaan ${receiptNo}`}>
        Batalkan penerimaan
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Batalkan penerimaan ${receiptNo}?`}
        description={description}
        confirmLabel="Batalkan penerimaan"
        confirmVariant="danger"
        onConfirm={handleConfirm}
        loading={pending}
      >
        {error && (
          <p role="alert" className="text-base text-danger-700">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}

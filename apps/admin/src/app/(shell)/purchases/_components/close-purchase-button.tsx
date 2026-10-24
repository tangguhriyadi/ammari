"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Label, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { closePurchaseAction } from "../actions";

/** D19: one close action with a required reason. The server decides between "Dibatalkan"
 * (nothing arrived) and "Ditutup" (something arrived); the description tells her which.
 * `overpaidAmount` (finance viewers only): what was already paid above the bill closing would
 * leave (docs/plans/purchase-payments.md §3.1). Closing is still allowed; this only warns. */
export function ClosePurchaseButton({
  purchaseId,
  nothingArrived,
  overpaidAmount = null,
}: {
  purchaseId: string;
  nothingArrived: boolean;
  overpaidAmount?: number | null;
}) {
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
      const result = await closePurchaseAction({ purchaseId, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(result.data.status === "cancelled" ? "Pesanan dibatalkan" : "Pesanan ditutup");
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
        Tutup pesanan
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Tutup pesanan ini?"
        description={
          nothingArrived
            ? "Belum ada barang yang diterima, jadi pesanan akan tercatat sebagai Dibatalkan. Tidak ada stok yang berubah."
            : "Sisa barang yang belum datang tidak akan ditunggu lagi. Barang yang sudah diterima tetap di stok."
        }
        confirmLabel="Tutup pesanan"
        onConfirm={handleConfirm}
        loading={pending}
      >
        {overpaidAmount !== null && (
          <p className="mb-3 rounded-md bg-warning-50 p-2 text-sm text-warning-700" data-testid="close-overpaid-warning">
            Pembayaran yang sudah dicatat melebihi tagihan setelah ditutup. Pesanan akan tercatat Lebih bayar {formatRupiah(overpaidAmount)}.
          </p>
        )}
        <Label htmlFor="close-reason" required>
          Alasan
        </Label>
        <Textarea id="close-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
        {error && (
          <p role="alert" className="mt-2 text-base text-danger-700">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}

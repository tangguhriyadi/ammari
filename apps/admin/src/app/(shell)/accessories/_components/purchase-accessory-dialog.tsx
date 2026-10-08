"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, Input, Label, Textarea } from "@ammari/ui";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { recordAccessoryPurchaseAction } from "../actions";

export function PurchaseAccessoryDialog({
  accessoryId,
  open,
  onOpenChange,
}: {
  accessoryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [qty, setQty] = useState("");
  const [totalAmountPaid, setTotalAmountPaid] = useState("");
  const [purchasedAt, setPurchasedAt] = useState(todayInJakarta());
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const parsedQty = Number.parseInt(qty, 10);
  const parsedAmount = Number.parseInt(totalAmountPaid.replace(/\D/g, ""), 10);
  const pricePerUnit = Number.isFinite(parsedQty) && parsedQty > 0 && Number.isFinite(parsedAmount) ? Math.round(parsedAmount / parsedQty) : null;

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await recordAccessoryPurchaseAction({
        accessoryId,
        qty,
        totalAmountPaid,
        purchasedAt,
        supplier: supplier || undefined,
        note: note || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setQty("");
      setTotalAmountPaid("");
      setSupplier("");
      setNote("");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Catat pembelian" confirmLabel="Simpan" onConfirm={handleConfirm} loading={pending}>
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="purchase-date" required>
            Tanggal
          </Label>
          <Input id="purchase-date" type="date" value={purchasedAt} onChange={(event) => setPurchasedAt(event.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="purchase-qty" required>
              Jumlah (pcs)
            </Label>
            <Input id="purchase-qty" inputMode="numeric" value={qty} onChange={(event) => setQty(event.target.value)} placeholder="0" />
          </div>
          <div>
            <Label htmlFor="purchase-amount" required>
              Total harga
            </Label>
            <Input
              id="purchase-amount"
              inputMode="numeric"
              value={totalAmountPaid}
              onChange={(event) => setTotalAmountPaid(event.target.value)}
              placeholder="0"
            />
          </div>
        </div>
        {pricePerUnit !== null && <p className="text-sm text-neutral-600">≈ Rp {pricePerUnit.toLocaleString("id-ID")}/pcs (otomatis)</p>}
        <div>
          <Label htmlFor="purchase-supplier">Pemasok</Label>
          <Input id="purchase-supplier" value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="Opsional" />
        </div>
        <div>
          <Label htmlFor="purchase-note">Catatan</Label>
          <Textarea id="purchase-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
        </div>
        {error && (
          <p role="alert" className="text-base text-danger-700">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Button, Input, Label, Select, Textarea } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { recordPurchaseAction } from "../actions";

export interface PurchaseItemOption {
  id: string;
  name: string;
}

type PurchaseItemType = "fabric" | "accessory";

export function PurchaseForm({ fabrics, accessories }: { fabrics: PurchaseItemOption[]; accessories: PurchaseItemOption[] }) {
  const router = useRouter();
  const [type, setType] = useState<PurchaseItemType>("fabric");
  const [itemId, setItemId] = useState(fabrics[0]?.id ?? "");
  const [purchasedAt, setPurchasedAt] = useState(todayInJakarta());
  const [qty, setQty] = useState("");
  const [totalAmountPaid, setTotalAmountPaid] = useState("");
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const items = type === "fabric" ? fabrics : accessories;

  function handleTypeChange(nextType: PurchaseItemType) {
    setType(nextType);
    const nextItems = nextType === "fabric" ? fabrics : accessories;
    setItemId(nextItems[0]?.id ?? "");
  }

  const unitPrice = useMemo(() => {
    const parsedQty = Number.parseFloat(qty.replace(",", "."));
    const parsedAmount = Number.parseInt(totalAmountPaid.replace(/\D/g, ""), 10);
    if (!Number.isFinite(parsedQty) || parsedQty <= 0 || !Number.isFinite(parsedAmount)) return null;
    return Math.round(parsedAmount / parsedQty);
  }, [qty, totalAmountPaid]);

  function handleSubmit() {
    setError(null);
    if (!itemId) {
      setError("Pilih bahan atau aksesoris terlebih dahulu.");
      return;
    }
    startTransition(async () => {
      const result = await recordPurchaseAction({
        type,
        itemId,
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
      router.push(`/purchases/${result.data.id}`);
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <div>
        <Label htmlFor="purchase-type" required>
          Jenis
        </Label>
        <Select id="purchase-type" value={type} onChange={(event) => handleTypeChange(event.target.value as PurchaseItemType)}>
          <option value="fabric">Kain</option>
          <option value="accessory">Aksesoris</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="purchase-item" required>
          {type === "fabric" ? "Bahan" : "Aksesoris"}
        </Label>
        <Select id="purchase-item" value={itemId} onChange={(event) => setItemId(event.target.value)}>
          {items.length === 0 && <option value="">Belum ada data</option>}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="purchase-date" required>
          Tanggal
        </Label>
        <Input id="purchase-date" type="date" value={purchasedAt} onChange={(event) => setPurchasedAt(event.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="purchase-qty" required>
            Jumlah ({type === "fabric" ? "yard" : "pcs"})
          </Label>
          <Input
            id="purchase-qty"
            inputMode={type === "fabric" ? "decimal" : "numeric"}
            value={qty}
            onChange={(event) => setQty(event.target.value)}
            placeholder="0"
          />
        </div>
        <div>
          <Label htmlFor="purchase-amount" required>
            Total dibayar
          </Label>
          <Input
            id="purchase-amount"
            inputMode="numeric"
            value={totalAmountPaid}
            onChange={(event) => setTotalAmountPaid(event.target.value)}
            placeholder="0"
          />
          <p className="mt-1 text-sm text-neutral-600">Termasuk ongkir jika ada.</p>
        </div>
      </div>
      {unitPrice !== null && (
        <p className="text-sm text-neutral-600">
          ≈ {formatRupiah(unitPrice)}/{type === "fabric" ? "yard" : "pcs"} (otomatis)
        </p>
      )}
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
      <Button type="submit" loading={pending}>
        Simpan
      </Button>
    </form>
  );
}

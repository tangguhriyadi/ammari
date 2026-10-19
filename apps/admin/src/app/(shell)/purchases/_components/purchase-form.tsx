"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { PurchaseItemType } from "@ammari/db/schema";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { parseRupiah } from "@/lib/products/money";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
import { createPurchaseAction, updatePurchaseAction } from "../actions";

export interface PurchaseItemOption {
  id: string;
  name: string;
}

export interface PurchaseFormLine {
  itemType: PurchaseItemType;
  itemId: string;
  qtyOrdered: string;
  totalAmount: string;
}

export interface PurchaseFormValues {
  supplierId: string;
  orderedAt: string;
  notes: string;
  lines: PurchaseFormLine[];
}

interface KeyedLine extends PurchaseFormLine {
  key: number;
}

export type PurchaseFormProps = {
  suppliers: PurchaseItemOption[];
  /** The document's saved supplier when it is no longer selectable (deactivated since). */
  currentSupplier?: PurchaseItemOption | null;
  fabrics: PurchaseItemOption[];
  accessories: PurchaseItemOption[];
} & ({ mode: "create" } | { mode: "edit"; purchaseId: string; initialValues: PurchaseFormValues });

const EMPTY_LINE: PurchaseFormLine = { itemType: "fabric", itemId: "", qtyOrdered: "", totalAmount: "" };

const UNIT_LABELS: Record<PurchaseItemType, string> = { fabric: "yard", accessory: "pcs" };

/** "≈ Rp X/yard (otomatis)" for one line, or null while either field is incomplete. Display only;
 * the server never stores a unit price (D6). */
function unitPriceHint(line: PurchaseFormLine): string | null {
  const qty = parseDecimalQuantity(line.qtyOrdered);
  const amount = parseRupiah(line.totalAmount);
  if (qty === null || amount === null) return null;
  return `≈ ${formatRupiah(Math.round(amount / qty))}/${UNIT_LABELS[line.itemType]} (otomatis)`;
}

export function PurchaseForm(props: PurchaseFormProps) {
  const { suppliers, currentSupplier, fabrics, accessories } = props;
  const router = useRouter();
  const toast = useToast();
  const initial = props.mode === "edit" ? props.initialValues : null;
  const initialLines = initial?.lines ?? [EMPTY_LINE];
  // Stable React keys for the repeatable rows: the initial rows are 0..n-1, and the ref (read
  // only in event handlers, never during render) hands out the next one when a row is added.
  const nextKey = useRef(initialLines.length);
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [orderedAt, setOrderedAt] = useState(initial?.orderedAt ?? todayInJakarta());
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<KeyedLine[]>(() => initialLines.map((line, index) => ({ ...line, key: index })));

  function addLine() {
    const key = nextKey.current;
    nextKey.current += 1;
    setLines((current) => [...current, { ...EMPTY_LINE, key }]);
  }
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const supplierMissing = currentSupplier && !suppliers.some((supplier) => supplier.id === currentSupplier.id);

  function updateLine(key: number, patch: Partial<PurchaseFormLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function handleSubmit() {
    setError(null);
    if (!supplierId) {
      setError("Pilih supplier terlebih dahulu.");
      return;
    }
    if (lines.some((line) => !line.itemId)) {
      setError("Pilih barang untuk setiap baris.");
      return;
    }
    startTransition(async () => {
      const payload = {
        supplierId,
        orderedAt,
        notes: notes || undefined,
        lines: lines.map(({ itemType, itemId, qtyOrdered, totalAmount }) => ({ itemType, itemId, qtyOrdered, totalAmount })),
      };
      const result = props.mode === "create" ? await createPurchaseAction(payload) : await updatePurchaseAction(props.purchaseId, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(props.mode === "create" ? "Pesanan pembelian berhasil dibuat" : "Perubahan berhasil disimpan");
      router.push("/purchases");
      router.refresh();
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
        <Label htmlFor="purchase-supplier" required>
          Supplier
        </Label>
        <Select id="purchase-supplier" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
          <option value="">Pilih supplier</option>
          {supplierMissing && <option value={currentSupplier.id}>{`${currentSupplier.name} (nonaktif)`}</option>}
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </Select>
        {suppliers.length === 0 && (
          <p className="mt-1 text-sm text-neutral-600">
            Belum ada supplier aktif.{" "}
            <Link href="/suppliers/new" className="font-medium text-brand hover:underline">
              Tambah supplier
            </Link>
          </p>
        )}
      </div>
      <div>
        <Label htmlFor="purchase-date" required>
          Tanggal pesan
        </Label>
        <Input id="purchase-date" type="date" value={orderedAt} max={todayInJakarta()} onChange={(event) => setOrderedAt(event.target.value)} />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-neutral-900">Barang yang dipesan</legend>
        {lines.map((line, index) => {
          const number = index + 1;
          const items = line.itemType === "fabric" ? fabrics : accessories;
          const hint = unitPriceHint(line);
          return (
            <div key={line.key} className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3" data-testid="purchase-line">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-neutral-700">Barang {number}</span>
                {lines.length > 1 && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}
                    aria-label={`Hapus barang ${number}`}
                  >
                    Hapus
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`line-${line.key}-type`} required>
                    Jenis
                  </Label>
                  <Select
                    id={`line-${line.key}-type`}
                    aria-label={`Jenis barang ${number}`}
                    value={line.itemType}
                    onChange={(event) => updateLine(line.key, { itemType: event.target.value as PurchaseItemType, itemId: "" })}
                  >
                    <option value="fabric">Kain</option>
                    <option value="accessory">Aksesoris</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`line-${line.key}-item`} required>
                    {line.itemType === "fabric" ? "Bahan" : "Aksesoris"}
                  </Label>
                  <Select
                    id={`line-${line.key}-item`}
                    aria-label={`Barang ${number}`}
                    value={line.itemId}
                    onChange={(event) => updateLine(line.key, { itemId: event.target.value })}
                  >
                    <option value="">{items.length === 0 ? "Belum ada data" : "Pilih"}</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`line-${line.key}-qty`} required>
                    Jumlah ({UNIT_LABELS[line.itemType]})
                  </Label>
                  <Input
                    id={`line-${line.key}-qty`}
                    aria-label={`Jumlah barang ${number}`}
                    inputMode={line.itemType === "fabric" ? "decimal" : "numeric"}
                    value={line.qtyOrdered}
                    onChange={(event) => updateLine(line.key, { qtyOrdered: event.target.value })}
                    placeholder="0"
                  />
                </div>
                <div>
                  <Label htmlFor={`line-${line.key}-amount`} required>
                    Total dibayar
                  </Label>
                  <Input
                    id={`line-${line.key}-amount`}
                    aria-label={`Total dibayar barang ${number}`}
                    inputMode="numeric"
                    value={line.totalAmount}
                    onChange={(event) => updateLine(line.key, { totalAmount: event.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>
              <p className="text-sm text-neutral-600">{hint ?? "Total termasuk ongkir jika ada."}</p>
            </div>
          );
        })}
        <div>
          <Button type="button" variant="secondary" onClick={addLine}>
            + Tambah barang
          </Button>
        </div>
      </fieldset>

      <div>
        <Label htmlFor="purchase-notes">Catatan</Label>
        <Textarea id="purchase-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
      </div>
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Link href={props.mode === "edit" ? `/purchases/${props.purchaseId}` : "/purchases"}>
          <Button type="button" variant="secondary">
            Batal
          </Button>
        </Link>
        <Button type="submit" loading={pending}>
          Simpan
        </Button>
      </div>
    </form>
  );
}

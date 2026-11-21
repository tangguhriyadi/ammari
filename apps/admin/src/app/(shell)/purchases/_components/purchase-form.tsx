"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button, ColorSwatch, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { PurchaseItemType } from "@ammari/db/schema";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { parseRupiah } from "@/lib/products/money";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
// Type-only: erased at build, so the server-only module is never bundled into this client file.
import type { PurchaseFabricColorOption, PurchaseFabricOption } from "@/lib/purchases/queries";
import { createPurchaseAction, updatePurchaseAction } from "../actions";

export interface PurchaseItemOption {
  id: string;
  name: string;
}

export interface PurchaseFormLine {
  itemType: PurchaseItemType;
  itemId: string;
  /** "" = Tanpa warna (docs/plans/fabric-colour-stock.md D4). */
  fabricColorId: string;
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
  /** "Harga/yard" helper: fills Total harga, never sent (only the total is stored, D6). */
  unitPrice: string;
  /** A colourless fabric line the document already had (edit only): it may stay as it is even if
   * the fabric has colours now (decision A2 applies to new lines). Cleared once its fabric changes. */
  legacyColorless: boolean;
}

export type PurchaseFormProps = {
  suppliers: PurchaseItemOption[];
  /** The document's saved supplier when it is no longer selectable (deactivated since). */
  currentSupplier?: PurchaseItemOption | null;
  fabrics: PurchaseFabricOption[];
  accessories: PurchaseItemOption[];
} & ({ mode: "create" } | { mode: "edit"; purchaseId: string; initialValues: PurchaseFormValues });

const EMPTY_LINE: PurchaseFormLine = { itemType: "fabric", itemId: "", fabricColorId: "", qtyOrdered: "", totalAmount: "" };

const UNIT_LABELS: Record<PurchaseItemType, string> = { fabric: "yard", accessory: "pcs" };

/** "≈ Rp X/yard (otomatis)" for one line, or null while either field is incomplete. Display only;
 * the server never stores a unit price (D6). */
function unitPriceHint(line: PurchaseFormLine): string | null {
  const qty = parseDecimalQuantity(line.qtyOrdered);
  const amount = parseRupiah(line.totalAmount);
  if (qty === null || amount === null) return null;
  return `≈ ${formatRupiah(Math.round(amount / qty))}/${UNIT_LABELS[line.itemType]} (otomatis)`;
}

/** round(qty × Harga/yard) formatted like a typed amount ("16.341.000"), or null while either is
 * incomplete. */
function totalFromUnitPrice(qtyText: string, unitPriceText: string): string | null {
  const qty = parseDecimalQuantity(qtyText);
  const unitPrice = parseRupiah(unitPriceText);
  if (qty === null || unitPrice === null) return null;
  // Integer hundredths of a yard, so 0.29 yard × Rp 100 is exactly Rp 29.
  return (Math.round((Math.round(qty * 100) * unitPrice) / 100)).toLocaleString("id-ID");
}

function formatYards(centiYards: number): string {
  return `${(centiYards / 100).toFixed(2)} yard`;
}

function colorLabel(color: PurchaseFabricColorOption): string {
  const code = color.supplierColorCode ? ` · ${color.supplierColorCode}` : "";
  return `${color.name}${code}${color.isActive ? "" : " (nonaktif)"}`;
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
  const [lines, setLines] = useState<KeyedLine[]>(() =>
    initialLines.map((line, index) => ({
      ...line,
      key: index,
      unitPrice: "",
      legacyColorless: initial !== null && line.itemType === "fabric" && line.itemId !== "" && line.fabricColorId === "",
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const supplierMissing = currentSupplier && !suppliers.some((supplier) => supplier.id === currentSupplier.id);
  const fabricsById = new Map(fabrics.map((fabric) => [fabric.id, fabric]));

  function takeKey(): number {
    const key = nextKey.current;
    nextKey.current += 1;
    return key;
  }

  function addLine() {
    const key = takeKey();
    setLines((current) => [...current, { ...EMPTY_LINE, key, unitPrice: "", legacyColorless: false }]);
  }

  function updateLine(key: number, patch: Partial<KeyedLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  /** Jumlah or Harga/yard changed: refill Total harga when both are complete. A typed Total harga
   * (ongkir included) stays until one of the two changes again. */
  function updateQtyOrUnitPrice(line: KeyedLine, patch: Pick<Partial<KeyedLine>, "qtyOrdered" | "unitPrice">) {
    const next = { ...line, ...patch };
    const total = line.itemType === "fabric" ? totalFromUnitPrice(next.qtyOrdered, next.unitPrice) : null;
    updateLine(line.key, total === null ? patch : { ...patch, totalAmount: total });
  }

  /** Colours of this line's fabric already used by OTHER lines of the document. */
  function colorsTakenElsewhere(line: KeyedLine): Set<string> {
    return new Set(
      lines.filter((other) => other.key !== line.key && other.itemType === "fabric" && other.itemId === line.itemId && other.fabricColorId).map((other) => other.fabricColorId),
    );
  }

  /** Active colours of the line's fabric not on the document yet (this line included). */
  function missingColors(line: KeyedLine): PurchaseFabricColorOption[] {
    const fabric = fabricsById.get(line.itemId);
    if (!fabric) return [];
    const taken = colorsTakenElsewhere(line);
    return fabric.colors.filter((color) => color.isActive && !taken.has(color.id) && color.id !== line.fabricColorId);
  }

  /** "Tambah semua warna": one line per active colour not on the document yet. A colourless new
   * line becomes the first of them; a line that already has a colour, or a kept legacy colourless
   * line (removed by hand, docs/plans/fabric-colour-stock.md §8), stays and the rest follow it. Each
   * new line keeps the typed Harga/yard, Jumlah empty. */
  function addAllColors(line: KeyedLine) {
    const missing = missingColors(line);
    if (missing.length === 0) return;
    const turnsIntoFirst = !line.fabricColorId && !line.legacyColorless;
    const toAppend = turnsIntoFirst ? missing.slice(1) : missing;
    const newLines: KeyedLine[] = toAppend.map((color) => ({
      key: takeKey(),
      itemType: "fabric",
      itemId: line.itemId,
      fabricColorId: color.id,
      qtyOrdered: "",
      totalAmount: "",
      unitPrice: line.unitPrice,
      legacyColorless: false,
    }));
    setLines((current) =>
      current.flatMap((candidate) => {
        if (candidate.key !== line.key) return [candidate];
        const self = turnsIntoFirst ? { ...candidate, fabricColorId: missing[0]!.id } : candidate;
        return [self, ...newLines];
      }),
    );
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
    const needsColor = lines.find(
      (line) =>
        line.itemType === "fabric" &&
        !line.fabricColorId &&
        !line.legacyColorless &&
        (fabricsById.get(line.itemId)?.colors.some((color) => color.isActive) ?? false),
    );
    if (needsColor) {
      setError(`Pilih warna untuk ${fabricsById.get(needsColor.itemId)!.name}.`);
      return;
    }
    startTransition(async () => {
      const payload = {
        supplierId,
        orderedAt,
        notes: notes || undefined,
        lines: lines.map(({ itemType, itemId, fabricColorId, qtyOrdered, totalAmount }) => ({
          itemType,
          itemId,
          fabricColorId: itemType === "fabric" ? fabricColorId : "",
          qtyOrdered,
          totalAmount,
        })),
      };
      const result = props.mode === "create" ? await createPurchaseAction(payload) : await updatePurchaseAction(props.purchaseId, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(props.mode === "create" ? "Pesanan pembelian berhasil dibuat" : "Perubahan berhasil disimpan");
      router.push("/purchases");
    });
  }

  // Footer: yards per fabric across its colour lines, and the document total.
  const fabricTotals = new Map<string, { name: string; centiYards: number; amount: number }>();
  let documentTotal = 0;
  for (const line of lines) {
    const amount = parseRupiah(line.totalAmount) ?? 0;
    documentTotal += amount;
    const fabric = line.itemType === "fabric" ? fabricsById.get(line.itemId) : undefined;
    if (!fabric) continue;
    const entry = fabricTotals.get(fabric.id) ?? { name: fabric.name, centiYards: 0, amount: 0 };
    const qty = parseDecimalQuantity(line.qtyOrdered);
    entry.centiYards += qty === null ? 0 : Math.round(qty * 100);
    entry.amount += amount;
    fabricTotals.set(fabric.id, entry);
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
          const isFabric = line.itemType === "fabric";
          const items = isFabric ? fabrics : accessories;
          const hint = unitPriceHint(line);
          const fabric = isFabric ? fabricsById.get(line.itemId) : undefined;
          const hasActiveColors = fabric?.colors.some((color) => color.isActive) ?? false;
          // Shown when the fabric has colours to pick, or the line already holds one (even inactive).
          const showColor = fabric !== undefined && (hasActiveColors || line.fabricColorId !== "");
          const selectedColor = fabric?.colors.find((color) => color.id === line.fabricColorId);
          const taken = showColor ? colorsTakenElsewhere(line) : new Set<string>();
          const missing = showColor ? missingColors(line) : [];
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
                    onChange={(event) =>
                      updateLine(line.key, { itemType: event.target.value as PurchaseItemType, itemId: "", fabricColorId: "", unitPrice: "", legacyColorless: false })
                    }
                  >
                    <option value="fabric">Kain</option>
                    <option value="accessory">Aksesoris</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`line-${line.key}-item`} required>
                    {isFabric ? "Bahan" : "Aksesoris"}
                  </Label>
                  <Select
                    id={`line-${line.key}-item`}
                    aria-label={`Barang ${number}`}
                    value={line.itemId}
                    onChange={(event) => updateLine(line.key, { itemId: event.target.value, fabricColorId: "", legacyColorless: false })}
                  >
                    <option value="">{items.length === 0 ? "Belum ada data" : "Pilih"}</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {showColor && fabric && (
                  <div className="sm:col-span-2">
                    <Label htmlFor={`line-${line.key}-color`} required={!line.legacyColorless}>
                      Warna
                    </Label>
                    <div className="flex items-center gap-2">
                      <ColorSwatch hex={selectedColor?.hex ?? null} className="size-6" />
                      <Select
                        id={`line-${line.key}-color`}
                        aria-label={`Warna barang ${number}`}
                        value={line.fabricColorId}
                        onChange={(event) => updateLine(line.key, { fabricColorId: event.target.value })}
                      >
                        <option value="">{line.legacyColorless ? "Tanpa warna (data lama)" : "Pilih warna"}</option>
                        {fabric.colors.map((color) => (
                          <option key={color.id} value={color.id} disabled={taken.has(color.id) || (!color.isActive && color.id !== line.fabricColorId)}>
                            {colorLabel(color)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {line.legacyColorless && !line.fabricColorId && hasActiveColors && (
                      <p className="mt-1 text-sm text-neutral-600">
                        Baris lama tanpa warna. Pilih warnanya, atau tambah baris per warna lalu hapus baris ini.
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <Label htmlFor={`line-${line.key}-qty`} required>
                    Jumlah ({UNIT_LABELS[line.itemType]})
                  </Label>
                  <Input
                    id={`line-${line.key}-qty`}
                    aria-label={`Jumlah barang ${number}`}
                    inputMode={isFabric ? "decimal" : "numeric"}
                    value={line.qtyOrdered}
                    onChange={(event) => updateQtyOrUnitPrice(line, { qtyOrdered: event.target.value })}
                    placeholder="0"
                  />
                </div>
                {isFabric && (
                  <div>
                    <Label htmlFor={`line-${line.key}-unit-price`}>Harga/yard</Label>
                    <Input
                      id={`line-${line.key}-unit-price`}
                      aria-label={`Harga per yard barang ${number}`}
                      inputMode="numeric"
                      value={line.unitPrice}
                      onChange={(event) => updateQtyOrUnitPrice(line, { unitPrice: event.target.value })}
                      placeholder="Opsional"
                    />
                  </div>
                )}
                <div>
                  <Label htmlFor={`line-${line.key}-amount`} required>
                    Total harga
                  </Label>
                  <Input
                    id={`line-${line.key}-amount`}
                    aria-label={`Total harga barang ${number}`}
                    inputMode="numeric"
                    value={line.totalAmount}
                    onChange={(event) => updateLine(line.key, { totalAmount: event.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>
              <p className="text-sm text-neutral-600">{hint ?? "Total termasuk ongkir jika ada."}</p>
              {missing.length > 0 && (
                <div>
                  <Button type="button" variant="secondary" onClick={() => addAllColors(line)} aria-label={`Tambah semua warna barang ${number}`}>
                    Tambah semua warna
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        <div>
          <Button type="button" variant="secondary" onClick={addLine}>
            + Tambah barang
          </Button>
        </div>
      </fieldset>

      <div className="flex flex-col gap-1 rounded-lg bg-neutral-50 p-3 text-sm text-neutral-800" data-testid="purchase-form-totals">
        {[...fabricTotals.entries()].map(([fabricId, entry]) => (
          <div key={fabricId} className="flex justify-between gap-3">
            <span>{entry.name}</span>
            <span className="tabular-nums">
              {formatYards(entry.centiYards)} · {formatRupiah(entry.amount)}
            </span>
          </div>
        ))}
        <div className="flex justify-between gap-3 font-medium text-neutral-900">
          <span>Total pesanan</span>
          <span className="tabular-nums">{formatRupiah(documentTotal)}</span>
        </div>
      </div>

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

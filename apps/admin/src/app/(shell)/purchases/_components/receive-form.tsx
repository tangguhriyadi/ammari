"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea, useToast } from "@ammari/ui";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
import { receivePurchaseAction } from "../actions";
import { receiveBatchAction } from "../../production/actions";

/** One shared receipt form for both sources (docs/plans/suppliers-goods-receipt.md §7): purchase
 * lines (fabric in yards, accessories in pcs) and production batch lines (whole pcs per variant).
 * Each row takes what arrived good ("diterima", into sellable stock) and, from S5, what arrived
 * defective ("Ditolak (cacat)", into defect stock); both use up what is left on the line. */
export interface ReceiveLine {
  id: string;
  itemName: string;
  unit: "yard" | "pcs";
  /** Accessories and production output are whole pcs; fabric yards take two decimals. */
  wholeOnly: boolean;
  outstanding: number;
  /** Production lines also show what was planned and what is already in. */
  planned?: number;
  received?: number;
  /** Already rejected into defect stock (shown when non-zero). */
  rejected?: number;
}

export type ReceiveSource = { type: "purchase"; purchaseId: string } | { type: "production_batch"; batchId: string };

function formatQty(line: Pick<ReceiveLine, "wholeOnly">, qty: number): string {
  return line.wholeOnly ? String(qty) : qty.toFixed(2);
}

/** One quantity input: 0 when blank or zero, null when invalid. */
function parseRowQty(line: ReceiveLine, raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /^0+(\.0+)?$/.test(trimmed)) return 0;
  const qty = parseDecimalQuantity(trimmed);
  if (qty === null || (line.wholeOnly && !Number.isInteger(qty))) return null;
  return qty;
}

interface RowError {
  message: string;
  /** Which input(s) the message is about, so only those are marked invalid. */
  accepted: boolean;
  rejected: boolean;
}

/** Client-side check of one row against what is left (D17: good + defective together). The server
 * re-checks inside its lock; this only spares a round trip. Returns an Indonesian message or null. */
function rowError(line: ReceiveLine, acceptedRaw: string, rejectedRaw: string, outstandingLabel: string): RowError | null {
  const accepted = parseRowQty(line, acceptedRaw);
  const rejected = parseRowQty(line, rejectedRaw);
  const invalid = line.wholeOnly ? "harus bilangan bulat." : "tidak valid.";
  if (accepted === null) return { message: `Jumlah diterima ${invalid}`, accepted: true, rejected: false };
  if (rejected === null) return { message: `Jumlah ditolak ${invalid}`, accepted: false, rejected: true };
  if (Math.round(accepted * 100) + Math.round(rejected * 100) > Math.round(line.outstanding * 100)) {
    return rejected > 0
      ? { message: `Diterima ditambah ditolak melebihi ${outstandingLabel} (${formatQty(line, line.outstanding)} ${line.unit}).`, accepted: true, rejected: true }
      : { message: `Melebihi ${outstandingLabel} (${formatQty(line, line.outstanding)} ${line.unit}).`, accepted: true, rejected: false };
  }
  return null;
}

export function ReceiveForm({ source, receiverName, lines }: { source: ReceiveSource; receiverName: string; lines: ReceiveLine[] }) {
  const router = useRouter();
  const toast = useToast();
  const today = todayInJakarta();
  const [receivedAt, setReceivedAt] = useState(today);
  const [receivedByName, setReceivedByName] = useState("");
  const [note, setNote] = useState("");
  // Prefilled with what is left on each line — the common case is "everything arrived".
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, formatQty(line, line.outstanding)])),
  );
  // Defective units are the exception: blank by default.
  const [rejectedQuantities, setRejectedQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isBatch = source.type === "production_batch";
  const backHref = isBatch ? `/production/${source.batchId}` : `/purchases/${source.purchaseId}`;
  const outstandingLabel = isBatch ? "sisa batch" : "sisa pesanan";

  const rowErrors = Object.fromEntries(
    lines.map((line) => [line.id, rowError(line, quantities[line.id] ?? "", rejectedQuantities[line.id] ?? "", outstandingLabel)]),
  );
  const hasRowError = Object.values(rowErrors).some((rowErr) => rowErr !== null);

  function handleSubmit() {
    setError(null);
    if (hasRowError) {
      setError("Periksa lagi jumlah yang diterima.");
      return;
    }
    const common = { receivedAt, receivedByName: receivedByName || undefined, note: note || undefined };
    startTransition(async () => {
      const result =
        source.type === "production_batch"
          ? await receiveBatchAction({
              ...common,
              batchId: source.batchId,
              lines: lines.map((line) => ({
                productionBatchItemId: line.id,
                qtyAccepted: quantities[line.id] ?? "",
                qtyRejected: rejectedQuantities[line.id] ?? "",
              })),
            })
          : await receivePurchaseAction({
              ...common,
              purchaseId: source.purchaseId,
              lines: lines.map((line) => ({
                purchaseItemId: line.id,
                qtyAccepted: quantities[line.id] ?? "",
                qtyRejected: rejectedQuantities[line.id] ?? "",
              })),
            });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`Penerimaan ${result.data.receiptNo} berhasil dicatat`);
      router.push(backHref);
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
        <Label htmlFor="receipt-date" required>
          Tanggal terima
        </Label>
        <Input id="receipt-date" type="date" value={receivedAt} max={today} onChange={(event) => setReceivedAt(event.target.value)} />
      </div>
      <div>
        <Label htmlFor="receipt-received-by">Diterima oleh</Label>
        <Input
          id="receipt-received-by"
          value={receivedByName}
          onChange={(event) => setReceivedByName(event.target.value)}
          placeholder="Opsional"
          aria-describedby="receipt-received-by-hint"
        />
        <p id="receipt-received-by-hint" className="mt-1 text-sm text-neutral-600">
          Dicatat oleh {receiverName}. Isi hanya jika barang diterima orang lain.
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-neutral-900">Jumlah per barang</legend>
        {lines.map((line) => {
          const inputId = `receive-${line.id}`;
          const rejectedId = `${inputId}-rejected`;
          const rowErr = rowErrors[line.id] ?? null;
          const hintId = `${inputId}-hint`;
          const labelId = `${inputId}-label`;
          const errorId = `${inputId}-error`;
          return (
            <div key={line.id} data-testid="receive-line" className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                <Label htmlFor={inputId} id={labelId}>
                  {line.itemName}
                </Label>
                <span id={hintId} className="text-sm text-neutral-600 tabular-nums">
                  {line.planned !== undefined && line.received !== undefined
                    ? `Rencana ${formatQty(line, line.planned)} · Diterima ${formatQty(line, line.received)} · `
                    : ""}
                  {line.rejected ? `Cacat ${formatQty(line, line.rejected)} · ` : ""}
                  Sisa {formatQty(line, line.outstanding)} {line.unit}
                </span>
              </div>
              <Input
                id={inputId}
                inputMode={line.wholeOnly ? "numeric" : "decimal"}
                value={quantities[line.id] ?? ""}
                onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                aria-invalid={rowErr?.accepted === true}
                aria-describedby={rowErr?.accepted ? `${hintId} ${errorId}` : hintId}
              />
              <div className="flex flex-col gap-1">
                {/* Named "Ditolak (cacat)" only; the row's item is in its description, so the good-
                    quantity input above stays the one input named after the item. */}
                <Label htmlFor={rejectedId}>Ditolak (cacat)</Label>
                <Input
                  id={rejectedId}
                  inputMode={line.wholeOnly ? "numeric" : "decimal"}
                  placeholder="0"
                  value={rejectedQuantities[line.id] ?? ""}
                  onChange={(event) => setRejectedQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                  aria-invalid={rowErr?.rejected === true}
                  aria-describedby={`${labelId} ${rejectedId}-hint${rowErr?.rejected ? ` ${errorId}` : ""}`}
                />
                <p id={`${rejectedId}-hint`} className="text-sm text-neutral-600">
                  Masuk stok cacat, tidak bisa dijual. Nanti bisa ditukar ke {isBatch ? "penjahit" : "supplier"} atau dilepas.
                </p>
              </div>
              {rowErr && (
                <p id={errorId} className="text-sm text-danger-700" aria-live="polite">
                  {rowErr.message}
                </p>
              )}
            </div>
          );
        })}
        <p className="text-sm text-neutral-600">
          {isBatch
            ? "Isi jumlah yang bagus dan siap dijual, lalu yang cacat di kolom Ditolak. Kosongkan atau isi 0 untuk yang belum datang."
            : "Isi jumlah yang bagus, lalu yang cacat di kolom Ditolak. Kosongkan atau isi 0 untuk barang yang belum datang."}
        </p>
      </fieldset>

      <div>
        <Label htmlFor="receipt-note">Catatan</Label>
        <Textarea id="receipt-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
      </div>
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Link href={backHref}>
          <Button type="button" variant="secondary">
            Batal
          </Button>
        </Link>
        <Button type="submit" loading={pending}>
          Simpan penerimaan
        </Button>
      </div>
    </form>
  );
}

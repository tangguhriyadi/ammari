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
 * lines (fabric in yards, accessories in pcs) and production batch lines (whole pcs per variant). */
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
}

export type ReceiveSource = { type: "purchase"; purchaseId: string } | { type: "production_batch"; batchId: string };

function formatQty(line: Pick<ReceiveLine, "wholeOnly">, qty: number): string {
  return line.wholeOnly ? String(qty) : qty.toFixed(2);
}

/** Client-side check of one row against what is left (D17). The server re-checks inside its lock;
 * this only spares a round trip. Returns an Indonesian message or null. */
function rowError(line: ReceiveLine, raw: string, outstandingLabel: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /^0+(\.0+)?$/.test(trimmed)) return null;
  const qty = parseDecimalQuantity(trimmed);
  if (qty === null) return "Jumlah tidak valid.";
  if (line.wholeOnly && !Number.isInteger(qty)) return "Harus bilangan bulat.";
  if (Math.round(qty * 100) > Math.round(line.outstanding * 100)) {
    return `Melebihi ${outstandingLabel} (${formatQty(line, line.outstanding)} ${line.unit}).`;
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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isBatch = source.type === "production_batch";
  const backHref = isBatch ? `/production/${source.batchId}` : `/purchases/${source.purchaseId}`;
  const outstandingLabel = isBatch ? "sisa batch" : "sisa pesanan";

  const rowErrors = Object.fromEntries(lines.map((line) => [line.id, rowError(line, quantities[line.id] ?? "", outstandingLabel)]));
  const hasRowError = Object.values(rowErrors).some((message) => message !== null);

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
              lines: lines.map((line) => ({ productionBatchItemId: line.id, qtyAccepted: quantities[line.id] ?? "" })),
            })
          : await receivePurchaseAction({
              ...common,
              purchaseId: source.purchaseId,
              lines: lines.map((line) => ({ purchaseItemId: line.id, qtyAccepted: quantities[line.id] ?? "" })),
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
        <legend className="mb-2 text-sm font-medium text-neutral-900">Jumlah diterima</legend>
        {lines.map((line) => {
          const inputId = `receive-${line.id}`;
          const message = rowErrors[line.id];
          const hintId = `${inputId}-hint`;
          return (
            <div key={line.id} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                <Label htmlFor={inputId}>{line.itemName}</Label>
                <span id={hintId} className="text-sm text-neutral-600 tabular-nums">
                  {line.planned !== undefined && line.received !== undefined
                    ? `Rencana ${formatQty(line, line.planned)} · Diterima ${formatQty(line, line.received)} · `
                    : ""}
                  Sisa {formatQty(line, line.outstanding)} {line.unit}
                </span>
              </div>
              <Input
                id={inputId}
                inputMode={line.wholeOnly ? "numeric" : "decimal"}
                value={quantities[line.id] ?? ""}
                onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                aria-invalid={message !== null}
                aria-describedby={message ? `${hintId} ${inputId}-error` : hintId}
              />
              {message && (
                <p id={`${inputId}-error`} className="text-sm text-danger-700" aria-live="polite">
                  {message}
                </p>
              )}
            </div>
          );
        })}
        <p className="text-sm text-neutral-600">
          {isBatch
            ? "Isi hanya barang yang bagus dan siap dijual. Kosongkan atau isi 0 untuk yang belum datang."
            : "Kosongkan atau isi 0 untuk barang yang belum datang."}
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

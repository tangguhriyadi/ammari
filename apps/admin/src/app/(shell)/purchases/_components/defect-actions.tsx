"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Input, Label, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { DefectDisposalType } from "@ammari/db/schema";
import { DEFECT_DISPOSAL_TYPE_LABELS } from "@/lib/defects/labels";
import { lineOutflowValue, type LineDefectTotals } from "@/lib/defects/valuation";
import { parseRupiah } from "@/lib/products/money";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { disposeDefectsAction, returnDefectsAction, reverseDefectMovementAction } from "../../stock/defects/actions";

// Defect dispositions on a document line (docs/plans/suppliers-goods-receipt.md §7, S6):
// "Kembalikan ke supplier", "Pelepasan" (Lelang / Hibah / Dibuang/Dimusnahkan) and "Batalkan" on
// a return or release. Shared by purchase documents and production batches. Rendered only for
// inventory.manage; the server actions re-check it and re-validate everything.

export type DefectSourceType = "purchase" | "production_batch";

interface LineProps {
  sourceType: DefectSourceType;
  lineId: string;
  itemLabel: string;
  /** Still held in defect stock from this line: the cap of both dialogs. */
  maxQty: number;
  /** Fabric is the only fractional kind (yards, 2 decimals); everything else is whole pcs. */
  isFabric: boolean;
}

function unit(isFabric: boolean): string {
  return isFabric ? "yard" : "pcs";
}

function formatQty(qty: number, isFabric: boolean): string {
  return isFabric ? `${qty.toFixed(2)} yard` : `${qty} pcs`;
}

/** Client-side mirror of the server's quantity rules, so obvious mistakes never round-trip. */
function parseQty(raw: string, maxQty: number, isFabric: boolean): { qty: number } | { error: string } {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed) || Number(trimmed) <= 0) return { error: "Jumlah tidak valid." };
  const qty = Number(trimmed);
  if (!isFabric && !Number.isInteger(qty)) return { error: "Jumlah harus bilangan bulat." };
  if (Math.round(qty * 100) > Math.round(maxQty * 100)) return { error: `Jumlah melebihi stok cacat tersedia (${formatQty(maxQty, isFabric)}).` };
  return { qty };
}

/** The server's valuation, for the preview only; null when the totals read for the page no longer
 * cover the quantity (the server re-checks and refuses). */
function previewOutflowValue(totals: LineDefectTotals, qty: number): number | null {
  try {
    return lineOutflowValue(totals, qty);
  } catch {
    return null;
  }
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-3 text-base text-danger-700">
      {error}
    </p>
  );
}

export function ReturnDefectsButton({ sourceType, lineId, itemLabel, maxQty, isFabric, documentClosed }: LineProps & { documentClosed: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = todayInJakarta();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("");
  const [occurredAt, setOccurredAt] = useState(today);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const idPrefix = `return-${useId()}`;
  const isPurchase = sourceType === "purchase";
  const buttonLabel = isPurchase ? "Kembalikan ke supplier" : "Kembalikan ke penjahit";
  const documentNoun = isPurchase ? "pesanan" : "batch";

  function handleConfirm() {
    setError(null);
    const parsed = parseQty(qty, maxQty, isFabric);
    if ("error" in parsed) return setError(parsed.error);
    if (reason.trim() === "") return setError("Alasan wajib diisi.");
    startTransition(async () => {
      const result = await returnDefectsAction({ sourceType, lineId, qty: qty.trim(), reason, occurredAt });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(result.data.reopened ? `Barang dikembalikan, ${documentNoun} dibuka kembali` : `Barang cacat dikembalikan ke ${isPurchase ? "supplier" : "penjahit"}`);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={`${buttonLabel}: ${itemLabel}`}
        onClick={() => {
          setQty(String(maxQty));
          setOccurredAt(today);
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        {buttonLabel}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Kembalikan ${itemLabel}`}
        description={
          documentClosed
            ? `Barang cacat keluar dari stok cacat untuk ditukar. ${isPurchase ? "Pesanan" : "Batch"} ini sudah ditutup dan akan dibuka kembali agar barang pengganti bisa diterima. Alasan yang diisi dicatat sebagai alasan pembukaan kembali.`
            : `Barang cacat keluar dari stok cacat untuk ditukar. Sisa ${documentNoun} bertambah sebanyak jumlah ini, lalu barang pengganti diterima seperti biasa.`
        }
        confirmLabel="Kembalikan"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-qty`} required>
              Jumlah ({unit(isFabric)})
            </Label>
            <Input id={`${idPrefix}-qty`} inputMode={isFabric ? "decimal" : "numeric"} value={qty} onChange={(event) => setQty(event.target.value)} />
            <p className="text-sm text-neutral-600">Stok cacat tersedia: {formatQty(maxQty, isFabric)}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-date`} required>
              Tanggal
            </Label>
            <Input id={`${idPrefix}-date`} type="date" value={occurredAt} max={today} onChange={(event) => setOccurredAt(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-reason`} required>
              Alasan
            </Label>
            <Textarea id={`${idPrefix}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
          </div>
        </div>
        <ErrorText error={error} />
      </Dialog>
    </>
  );
}

const DISPOSAL_OPTIONS: readonly { value: DefectDisposalType; hint: string }[] = [
  { value: "auction", hint: "Dijual murah, isi uang yang benar-benar diterima." },
  { value: "donation", hint: "Diberikan (zakat, sedekah, CSR). Hasil Rp 0." },
  { value: "discarded", hint: "Tidak bisa dipakai sama sekali. Hasil Rp 0." },
];

export function DisposeDefectsButton({
  sourceType,
  lineId,
  itemLabel,
  maxQty,
  isFabric,
  lineTotals,
}: LineProps & {
  /** This line's own defect totals, for the live value preview (a release is valued at its source
   * line, §10 R1); null without finance.view_profit. */
  lineTotals: LineDefectTotals | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const today = todayInJakarta();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("");
  const [disposalType, setDisposalType] = useState<DefectDisposalType>("auction");
  const [proceeds, setProceeds] = useState("");
  const [occurredAt, setOccurredAt] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const idPrefix = `dispose-${useId()}`;

  const parsedQty = parseQty(qty, maxQty, isFabric);
  const releasedValue = lineTotals && "qty" in parsedQty ? previewOutflowValue(lineTotals, parsedQty.qty) : null;
  const proceedsAmount = disposalType === "auction" ? (parseRupiah(proceeds) ?? 0) : 0;
  const netLoss = releasedValue !== null ? releasedValue - proceedsAmount : null;

  function handleConfirm() {
    setError(null);
    if ("error" in parsedQty) return setError(parsedQty.error);
    if (disposalType === "auction" && !(proceedsAmount > 0)) return setError("Hasil lelang wajib diisi dan lebih dari Rp 0.");
    if (note.trim() === "") return setError("Catatan wajib diisi.");
    startTransition(async () => {
      const result = await disposeDefectsAction({
        sourceType,
        lineId,
        qty: qty.trim(),
        disposalType,
        // Hidden and forced to Rp 0 for Hibah and Dibuang/Dimusnahkan (D24/D29).
        proceeds: disposalType === "auction" ? proceeds : "",
        note,
        occurredAt,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(`Barang cacat dilepas (${DEFECT_DISPOSAL_TYPE_LABELS[disposalType]})`);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={`Pelepasan barang cacat: ${itemLabel}`}
        onClick={() => {
          setQty(String(maxQty));
          setDisposalType("auction");
          setProceeds("");
          setOccurredAt(today);
          setNote("");
          setError(null);
          setOpen(true);
        }}
      >
        Pelepasan
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Pelepasan ${itemLabel}`}
        description="Barang cacat keluar dari stok cacat dan tidak diganti. Sisa yang ditunggu tidak bertambah."
        confirmLabel="Lepas barang"
        confirmVariant="danger"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-qty`} required>
              Jumlah ({unit(isFabric)})
            </Label>
            <Input id={`${idPrefix}-qty`} inputMode={isFabric ? "decimal" : "numeric"} value={qty} onChange={(event) => setQty(event.target.value)} />
            <p className="text-sm text-neutral-600">Stok cacat tersedia: {formatQty(maxQty, isFabric)}</p>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium text-neutral-900">Jenis pelepasan</legend>
            {DISPOSAL_OPTIONS.map((option) => (
              <label key={option.value} className="flex min-h-11 items-start gap-2 py-1 text-base text-neutral-900">
                <input
                  type="radio"
                  className="mt-1.5"
                  name={`${idPrefix}-type`}
                  value={option.value}
                  checked={disposalType === option.value}
                  onChange={() => setDisposalType(option.value)}
                />
                <span>
                  {DEFECT_DISPOSAL_TYPE_LABELS[option.value]}
                  <span className="block text-sm text-neutral-600">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {disposalType === "auction" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-proceeds`} required>
                Hasil lelang
              </Label>
              <Input id={`${idPrefix}-proceeds`} inputMode="numeric" placeholder="mis. 50.000" value={proceeds} onChange={(event) => setProceeds(event.target.value)} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-date`} required>
              Tanggal
            </Label>
            <Input id={`${idPrefix}-date`} type="date" value={occurredAt} max={today} onChange={(event) => setOccurredAt(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-note`} required>
              Catatan
            </Label>
            <Textarea id={`${idPrefix}-note`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
          </div>
          {releasedValue !== null && netLoss !== null && (
            <div className="flex flex-col gap-1 rounded-md bg-neutral-50 p-3 text-sm" data-testid="dispose-preview">
              <div className="flex justify-between gap-2">
                <span className="text-neutral-600">Nilai cacat dilepas</span>
                <span className="tabular-nums text-neutral-900">≈ {formatRupiah(releasedValue)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-neutral-600">{netLoss < 0 ? "Untung bersih" : "Kerugian bersih"}</span>
                <span className="tabular-nums font-medium text-neutral-900">≈ {formatRupiah(Math.abs(netLoss))}</span>
              </div>
            </div>
          )}
        </div>
        <ErrorText error={error} />
      </Dialog>
    </>
  );
}

/** "Batalkan" on a return or release: an exact reversing row, never an edit (D8). */
export function ReverseDefectButton({ movementId, description, label }: { movementId: string; description: string; /** Names the row for screen readers. */ label: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await reverseDefectMovementAction({ movementId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success("Catatan barang cacat dibatalkan");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={label}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Batalkan
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Batalkan catatan ini?"
        description={description}
        confirmLabel="Batalkan catatan"
        confirmVariant="danger"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <ErrorText error={error} />
      </Dialog>
    </>
  );
}

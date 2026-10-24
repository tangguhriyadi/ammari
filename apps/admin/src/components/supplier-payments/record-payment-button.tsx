"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { ActionResult } from "@/lib/action-result";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { PROOF_MESSAGES } from "@/lib/supplier-payments/messages";
import type { PaymentStatus } from "@/lib/supplier-payments/status";
import { findDuplicateProofAction } from "./actions";
import { PrivateFileField, type PreparedUpload } from "./private-file-field";

// "Catat pembayaran" (docs/plans/purchase-payments.md §9): date (default today), amount
// (prefilled with the remaining balance), Tunai/Transfer, a REQUIRED proof, optional note, and on
// a production batch "Dibayar kepada" (P12: the cap is per payee). The server re-checks every rule
// under the document's row lock; this form only gives early feedback.

const NOTE_MAX = 500;
// Mirrors batch-payments.ts NO_SUPPLIER_PAYEE_KEY (a server-only module, so not imported here).
const NO_SUPPLIER_PAYEE_KEY = "none";
const FIELDS = ["payee", "paidAt", "amount", "method", "proof", "note"] as const;

type FieldErrors = Partial<Record<(typeof FIELDS)[number], string>>;

export interface PayeeOption {
  /** What the form submits as `payee`: a supplier id, or the "Tanpa pemasok" key. */
  key: string;
  name: string;
  remaining: number;
}

export function RecordPaymentButton({
  recordAction,
  targetFields,
  documentNo,
  remaining,
  payees,
  paidMessage = "Pesanan lunas.",
}: {
  /** The target's own server action (purchases or production payment-actions.ts). */
  recordAction: (formData: FormData) => Promise<ActionResult<{ paymentNo: string; status: PaymentStatus }>>;
  /** The target's id field(s), e.g. `{ purchaseId }`. */
  targetFields: Record<string, string>;
  documentNo: string;
  /** The document's remaining balance; ignored when `payees` is given. */
  remaining?: number;
  /** A batch's payees with something left to pay, in display order. */
  payees?: PayeeOption[];
  /** Toast suffix once the document is settled; a payee's own name is used when there are payees. */
  paidMessage?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [payee, setPayee] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"transfer" | "cash">("transfer");
  const [note, setNote] = useState("");
  const [upload, setUpload] = useState<PreparedUpload | null>(null);
  const [processing, setProcessing] = useState(false);
  const [duplicateOf, setDuplicateOf] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();
  // The file whose duplicate lookup may still apply; a late answer for a replaced file is dropped.
  const latestSha = useRef<string | null>(null);

  const selectedPayee = payees?.find((option) => option.key === payee);
  const shownRemaining = payees ? (selectedPayee?.remaining ?? 0) : (remaining ?? 0);

  function reset() {
    const first = payees?.[0];
    setPayee(first?.key ?? "");
    setPaidAt(todayInJakarta());
    setAmount(formatNumber(payees ? (first?.remaining ?? 0) : (remaining ?? 0)));
    setMethod("transfer");
    setNote("");
    setUpload(null);
    setDuplicateOf([]);
    latestSha.current = null;
    setError(null);
    setFieldErrors({});
  }

  function handleUpload(value: PreparedUpload | null) {
    setUpload(value);
    setDuplicateOf([]);
    setFieldErrors((current) => ({ ...current, proof: undefined }));
    latestSha.current = value?.sha256 ?? null;
    if (!value?.sha256) return;
    const sha256 = value.sha256;
    // Advisory only (§8 step 4): a lookup failure just means no warning.
    void findDuplicateProofAction({ sha256 })
      .then((result) => {
        if (result.ok && latestSha.current === sha256) setDuplicateOf(result.data.paymentNos);
      })
      .catch(() => undefined);
  }

  function handleConfirm() {
    if (processing) return;
    setError(null);
    if (!upload) {
      setFieldErrors({ proof: PROOF_MESSAGES.missing });
      return;
    }
    if (paidAt > todayInJakarta()) {
      setFieldErrors({ paidAt: "Tanggal bayar tidak boleh di masa depan." });
      return;
    }
    setFieldErrors({});
    const formData = new FormData();
    for (const [name, value] of Object.entries(targetFields)) formData.set(name, value);
    if (payees) formData.set("payee", payee);
    formData.set("paidAt", paidAt);
    formData.set("amount", amount);
    formData.set("method", method);
    formData.set("note", note);
    formData.set("proof", upload.file, upload.file.name);
    startTransition(async () => {
      try {
        const result = await recordAction(formData);
        if (!result.ok) {
          // A field's own error shows under that field; anything else under the form.
          const shown: readonly string[] = FIELDS;
          if (result.fieldErrors && Object.keys(result.fieldErrors).every((key) => shown.includes(key))) setFieldErrors(result.fieldErrors as FieldErrors);
          else setError(result.error);
          return;
        }
        setOpen(false);
        const settled = selectedPayee ? `Tagihan ${selectedPayee.key === NO_SUPPLIER_PAYEE_KEY ? "tanpa pemasok" : selectedPayee.name} lunas.` : paidMessage;
        toast.success(result.data.status === "paid" ? `Pembayaran ${result.data.paymentNo} dicatat. ${settled}` : `Pembayaran ${result.data.paymentNo} dicatat.`);
        router.refresh();
      } catch {
        // A network drop or a body over the server's limit never reaches runAction.
        setError("Gagal mengunggah bukti. Periksa koneksi lalu coba lagi.");
      }
    });
  }

  const busy = pending || processing;

  return (
    <>
      <Button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Catat pembayaran
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title="Catat pembayaran"
        description={`${documentNo} · Sisa tagihan ${selectedPayee ? `${selectedPayee.name} ` : ""}${formatRupiah(shownRemaining)}`}
        confirmLabel="Simpan pembayaran"
        onConfirm={handleConfirm}
        // `busy`, not just `pending`: the dialog must not be dismissed (Escape, backdrop, Batal)
        // while a photo is still being prepared either.
        loading={busy}
      >
        <div className="flex flex-col gap-4">
          {payees && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-payee" required>
                Dibayar kepada
              </Label>
              <Select
                id="payment-payee"
                value={payee}
                onChange={(event) => {
                  const next = payees.find((option) => option.key === event.target.value);
                  setPayee(event.target.value);
                  // The cap is this payee's own remaining balance (P12), so the prefill follows it,
                  // and a refusal about the previous payee no longer applies.
                  if (next) setAmount(formatNumber(next.remaining));
                  setFieldErrors((current) => ({ ...current, amount: undefined, payee: undefined }));
                  setError(null);
                }}
                error={fieldErrors.payee}
                disabled={busy}
              >
                {payees.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name} (sisa {formatRupiah(option.remaining)})
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payment-date" required>
              Tanggal bayar
            </Label>
            <Input
              id="payment-date"
              type="date"
              value={paidAt}
              max={todayInJakarta()}
              onChange={(event) => setPaidAt(event.target.value)}
              error={fieldErrors.paidAt}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payment-amount" required>
              Jumlah
            </Label>
            <Input
              id="payment-amount"
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0"
              error={fieldErrors.amount}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payment-method" required>
              Metode
            </Label>
            <Select
              id="payment-method"
              value={method}
              onChange={(event) => setMethod(event.target.value === "cash" ? "cash" : "transfer")}
              error={fieldErrors.method}
              disabled={pending}
            >
              <option value="transfer">Transfer</option>
              <option value="cash">Tunai</option>
            </Select>
          </div>
          <PrivateFileField
            id="payment-proof"
            label="Bukti bayar"
            hint="Foto struk/nota atau screenshot transfer (JPG, PNG, WebP), atau PDF. Maksimal 10 MB."
            value={upload}
            onChange={handleUpload}
            onProcessingChange={setProcessing}
            error={fieldErrors.proof}
            disabled={pending}
          />
          {duplicateOf.length > 0 && (
            <p className="rounded-md bg-warning-50 p-2 text-sm text-warning-700" data-testid="duplicate-proof-warning">
              Bukti ini sudah dipakai untuk pembayaran {duplicateOf.join(", ")}. Pastikan ini bukan pembayaran yang sama.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payment-note">Catatan</Label>
            <Textarea
              id="payment-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="Opsional, mis. DP 30% atau pelunasan"
              disabled={pending}
            />
          </div>
          {pending && (
            <p className="text-sm text-neutral-600" aria-live="polite">
              Mengunggah dan menyimpan bukti...
            </p>
          )}
          {error && (
            <p role="alert" className="text-base text-danger-700">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

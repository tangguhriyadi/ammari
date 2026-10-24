"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { PROOF_MESSAGES } from "@/lib/supplier-payments/messages";
import { findDuplicateProofAction, recordPurchasePaymentAction } from "../payment-actions";
import { PrivateFileField, type PreparedUpload } from "./private-file-field";

// "Catat pembayaran" (docs/plans/purchase-payments.md §9): date (default today), amount
// (prefilled with the remaining balance), Tunai/Transfer, a REQUIRED proof, optional note. The
// server re-checks every rule under the purchase row lock; this form only gives early feedback.

const NOTE_MAX = 500;

type FieldErrors = Partial<Record<"paidAt" | "amount" | "method" | "proof" | "note", string>>;

export function RecordPaymentButton({ purchaseId, purchaseNo, remaining }: { purchaseId: string; purchaseNo: string; remaining: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
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

  function reset() {
    setPaidAt(todayInJakarta());
    setAmount(formatNumber(remaining));
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
    formData.set("purchaseId", purchaseId);
    formData.set("paidAt", paidAt);
    formData.set("amount", amount);
    formData.set("method", method);
    formData.set("note", note);
    formData.set("proof", upload.file, upload.file.name);
    startTransition(async () => {
      try {
        const result = await recordPurchasePaymentAction(formData);
        if (!result.ok) {
          // A field's own error shows under that field; anything else under the form.
          const shown = ["paidAt", "amount", "method", "proof", "note"];
          if (result.fieldErrors && Object.keys(result.fieldErrors).every((key) => shown.includes(key))) setFieldErrors(result.fieldErrors as FieldErrors);
          else setError(result.error);
          return;
        }
        setOpen(false);
        toast.success(result.data.status === "paid" ? `Pembayaran ${result.data.paymentNo} dicatat. Pesanan lunas.` : `Pembayaran ${result.data.paymentNo} dicatat.`);
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
        description={`${purchaseNo} · Sisa tagihan ${formatRupiah(remaining)}`}
        confirmLabel="Simpan pembayaran"
        onConfirm={handleConfirm}
        // `busy`, not just `pending`: the dialog must not be dismissed (Escape, backdrop, Batal)
        // while a photo is still being prepared either.
        loading={busy}
      >
        <div className="flex flex-col gap-4">
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

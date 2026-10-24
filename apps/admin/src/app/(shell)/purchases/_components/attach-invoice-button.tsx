"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Label, Textarea, useToast } from "@ammari/ui";
import { attachPurchaseInvoiceAction } from "../payment-actions";
import { PrivateFileField, type PreparedUpload } from "@/components/supplier-payments/private-file-field";

// "Lampirkan nota" (docs/plans/purchase-payments.md P13): the supplier's invoice, optional, many
// per purchase, never blocking anything. Same private storage and void rule as payment proofs.

const NOTA_MISSING = "File nota wajib dipilih.";

export function AttachInvoiceButton({ purchaseId }: { purchaseId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [upload, setUpload] = useState<PreparedUpload | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    if (processing) return;
    setError(null);
    if (!upload) {
      setFileError(NOTA_MISSING);
      return;
    }
    setFileError(null);
    const formData = new FormData();
    formData.set("purchaseId", purchaseId);
    formData.set("note", note);
    formData.set("file", upload.file, upload.file.name);
    startTransition(async () => {
      try {
        const result = await attachPurchaseInvoiceAction(formData);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setOpen(false);
        toast.success("Nota dilampirkan");
        router.refresh();
      } catch {
        setError("Gagal mengunggah nota. Periksa koneksi lalu coba lagi.");
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setNote("");
          setUpload(null);
          setError(null);
          setFileError(null);
          setOpen(true);
        }}
      >
        Lampirkan nota
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending && !processing) setOpen(next);
        }}
        title="Lampirkan nota pemasok"
        description="Foto atau PDF nota/invoice dari pemasok. Hanya bisa dilihat staf yang berhak melihat harga."
        confirmLabel="Simpan nota"
        onConfirm={handleConfirm}
        // Not dismissable while a photo is still being prepared either (see RecordPaymentButton).
        loading={pending || processing}
      >
        <div className="flex flex-col gap-4">
          <PrivateFileField
            id="invoice-file"
            label="File nota"
            hint="JPG, PNG, WebP, atau PDF. Maksimal 10 MB."
            value={upload}
            onChange={(value) => {
              setUpload(value);
              setFileError(null);
            }}
            onProcessingChange={setProcessing}
            error={fileError}
            disabled={pending}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invoice-note">Catatan</Label>
            <Textarea id="invoice-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} disabled={pending} />
          </div>
          {pending && (
            <p className="text-sm text-neutral-600" aria-live="polite">
              Mengunggah dan menyimpan nota...
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

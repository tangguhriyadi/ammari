"use client";

import { useRef, useState } from "react";
import { Button, Checkbox, Dialog } from "@ammari/ui";

// "Unduh kontak promo" (docs/plans/growth.md §10, owner answer A9): shown only with
// customers.export. The dialog states the only lawful use and asks for the tick; the route refuses
// without `ack=1` and re-checks the permissions, so this component is only the warning.

export const PROMO_EXPORT_ACK_LABEL = "Saya paham data ini hanya untuk promo Ammari sendiri dan tidak diunggah ke platform iklan.";

export function PromoExportButton() {
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const downloadRef = useRef<HTMLAnchorElement>(null);

  function handleConfirm() {
    if (!ack) {
      setError("Centang pernyataan di atas dulu.");
      return;
    }
    // A plain <a download> (as "Unduh CSV" on Log Aktivitas): the browser downloads and stays on
    // this page, and nothing prefetches the audited route.
    downloadRef.current?.click();
    setOpen(false);
  }

  return (
    <>
      <a ref={downloadRef} href="/customers/promo-export?ack=1" download hidden aria-hidden="true" tabIndex={-1} />
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setAck(false);
          setError(null);
          setOpen(true);
        }}
      >
        Unduh kontak promo
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Unduh kontak promo"
        description="Berisi nama, email, nomor HP dan tanggal setuju dari pelanggan yang menyetujui promo lewat akunnya dan belum menariknya."
        confirmLabel="Unduh CSV"
        onConfirm={handleConfirm}
      >
        <div className="flex flex-col gap-3">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-base text-neutral-800" data-testid="promo-export-warning">
            <li>Hanya untuk mengirim promo Ammari sendiri lewat WhatsApp atau email.</li>
            <li>Jangan unggah ke Meta, TikTok, atau platform iklan lain (misalnya custom audience). Kebijakan privasi Ammari tidak mengizinkannya.</li>
            <li>Ekspor ulang sebelum setiap kirim promo: pelanggan yang sudah berhenti tidak boleh dikirimi lagi.</li>
            <li>Simpan file di tempat aman dan hapus setelah selesai.</li>
          </ul>
          <Checkbox
            checked={ack}
            onChange={(event) => {
              setAck(event.target.checked);
              setError(null);
            }}
            label={PROMO_EXPORT_ACK_LABEL}
          />
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

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog } from "@ammari/ui";
import { setTikTokOrdersApplyAction } from "../actions";

// "Terapkan pesanan TikTok" (docs/plans/tiktok-shop-integration.md T5, the kill switch): turns the
// writing of admin orders and stock from TikTok on or off without a deploy. Both directions ask for
// confirmation; the server re-checks integrations.manage and audits the change.

export function TikTokOrdersApplyToggle({ enabled, disabled }: { enabled: boolean; disabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof setTikTokOrdersApplyAction>>;
      try {
        result = await setTikTokOrdersApplyAction({ enabled: !enabled });
      } catch {
        setError("Belum bisa menyimpan. Periksa koneksi lalu coba lagi.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant={enabled ? "danger" : "primary"} className="self-start" disabled={disabled || pending} loading={pending} onClick={() => setOpen(true)}>
        {enabled ? "Hentikan penerapan pesanan" : "Mulai terapkan pesanan"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => !next && setOpen(false)}
        title={enabled ? "Hentikan penerapan pesanan TikTok?" : "Mulai terapkan pesanan TikTok?"}
        description={
          enabled
            ? "Pesanan TikTok tetap dibaca dan disimpan, tapi tidak lagi dibuat atau diubah di admin, dan stok tidak berubah. Pesanan yang sudah masuk tetap ada."
            : "Pesanan TikTok yang sudah dibayar akan dibuat di admin dan stoknya langsung dikurangi. Status pesanan ikut berubah sesuai TikTok. Pastikan Pemetaan SKU TikTok sudah lengkap."
        }
        confirmLabel={enabled ? "Hentikan" : "Mulai terapkan"}
        confirmVariant={enabled ? "danger" : "primary"}
        loading={pending}
        onConfirm={confirm}
      />
    </div>
  );
}

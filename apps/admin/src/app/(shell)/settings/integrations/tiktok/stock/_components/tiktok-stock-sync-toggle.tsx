"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog } from "@ammari/ui";
import { setTikTokStockSyncAction } from "../../actions";

// "Sinkronkan stok ke TikTok" (docs/plans/tiktok-stock-sync.md decision 4, R1). Both directions ask for
// confirmation; the server re-checks integrations.manage, refuses ON while "Mulai terapkan pesanan" is
// OFF and audits the change. Turning it on starts the first full push (S2).

/** `reason`: why the button is disabled, shown under it and tied to it (aria-describedby). */
export function TikTokStockSyncToggle({ enabled, disabled, reason }: { enabled: boolean; disabled: boolean; reason?: string | null }) {
  const reasonId = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof setTikTokStockSyncAction>>;
      try {
        result = await setTikTokStockSyncAction({ enabled: !enabled });
      } catch {
        setOpen(false);
        setError("Belum bisa menyimpan. Periksa koneksi lalu coba lagi.");
        return;
      }
      setOpen(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={enabled ? "danger" : "primary"}
        className="self-start"
        disabled={disabled || pending}
        loading={pending}
        onClick={() => setOpen(true)}
        aria-describedby={reason ? reasonId : undefined}
      >
        {enabled ? "Hentikan sinkron stok" : "Sinkronkan stok ke TikTok"}
      </Button>
      {reason && (
        <p id={reasonId} className="text-sm text-neutral-600">
          {reason}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => !next && setOpen(false)}
        title={enabled ? "Hentikan sinkron stok TikTok?" : "Sinkronkan stok ke TikTok?"}
        description={
          enabled
            ? "Stok Ammari tidak lagi dikirim ke TikTok. Stok yang terakhir terkirim tetap seperti itu di TikTok."
            : "Mulai sekarang stok Ammari menimpa stok di TikTok untuk setiap SKU yang sudah dipetakan, termasuk perubahan manual di Seller Center. Cek pratinjau di bawah dulu."
        }
        confirmLabel={enabled ? "Hentikan" : "Sinkronkan"}
        confirmVariant={enabled ? "danger" : "primary"}
        loading={pending}
        onConfirm={confirm}
      />
    </div>
  );
}

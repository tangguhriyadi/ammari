"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog } from "@ammari/ui";
import { retryRefusedTikTokStockAction } from "../../actions";

// "Kirim ulang yang ditolak" (docs/plans/tiktok-stock-sync.md S2): after the owner fixed what TikTok
// refused (a promotion lock, a global product, shared inventory), the refusals are cleared and the push
// tries those SKUs once more. Confirmed; the server re-checks integrations.manage and audits it.

export function TikTokStockPushRetry() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setMessage(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof retryRefusedTikTokStockAction>>;
      try {
        result = await retryRefusedTikTokStockAction();
      } catch {
        setOpen(false);
        setMessage({ tone: "error", text: "Belum bisa mengirim ulang. Periksa koneksi lalu coba lagi." });
        return;
      }
      setOpen(false);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: result.data.cleared > 0 ? "Dikirim ulang. Hasilnya tampil di sini dalam beberapa menit." : "Tidak ada yang perlu dikirim ulang." });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" className="self-start" disabled={pending} loading={pending} onClick={() => setOpen(true)}>
        Kirim ulang yang ditolak
      </Button>
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-danger-700" : "text-sm text-neutral-700"}>
          {message.text}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => !next && setOpen(false)}
        title="Kirim ulang stok yang ditolak TikTok?"
        description="Lakukan ini setelah masalahnya diperbaiki di TikTok Seller Center (misalnya promo sudah berakhir). Stok untuk SKU tersebut dihitung ulang lalu dikirim lagi."
        confirmLabel="Kirim ulang"
        loading={pending}
        onConfirm={confirm}
      />
    </div>
  );
}

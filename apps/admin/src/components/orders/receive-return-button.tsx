"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, useToast } from "@ammari/ui";
import { receiveMarketplaceReturnAction } from "@/app/(shell)/orders/actions";
import { STOREFRONT_STALE_MESSAGE } from "@/lib/storefront-stale";

// "Retur diterima" (docs/plans/tiktok-shop-integration.md §4.5, Q11, Q18): staff confirm a parcel on
// its way back is physically here. Asks first (the stock comes back, the order becomes Retur); the
// server re-checks orders.manage and the in-transit flag.

export function ReceiveReturnButton({ orderId, orderNo, className }: { orderId: string; orderNo: string; className?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof receiveMarketplaceReturnAction>>;
      try {
        result = await receiveMarketplaceReturnAction({ orderId });
      } catch {
        setError("Belum bisa menyimpan. Periksa koneksi lalu coba lagi.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(`Retur ${result.data.orderNo} dicatat. Stok sudah dikembalikan.`);
      if (!result.data.storefrontOk) toast.error(STOREFRONT_STALE_MESSAGE);
      router.refresh();
    });
  }

  return (
    <div className={className}>
      <Button
        variant="primary"
        className="w-full md:w-auto"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        loading={pending}
        aria-label={`Retur diterima untuk ${orderNo}`}
      >
        Retur diterima
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) return;
          setOpen(false);
          setError(null);
        }}
        title={`Paket ${orderNo} sudah diterima?`}
        description="Tekan hanya kalau paketnya benar-benar sudah sampai di toko. Status pesanan menjadi Retur dan stok barangnya dikembalikan."
        confirmLabel="Ya, paket sudah diterima"
        confirmVariant="primary"
        loading={pending}
        onConfirm={confirm}
      >
        {/* Inside the dialog: a modal makes everything behind it inert, so an error outside would
            stay hidden until the dialog is closed. */}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger-700">
            {error}
          </p>
        )}
      </Dialog>
    </div>
  );
}

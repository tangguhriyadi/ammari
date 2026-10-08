"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog } from "@ammari/ui";
import { voidPurchaseAction } from "../actions";

export function VoidPurchaseButton({ type, movementId }: { type: "fabric" | "accessory"; movementId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await voidPurchaseAction({ type, movementId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant="danger" onClick={() => setOpen(true)}>
        Batalkan pembelian
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Batalkan pembelian ini?"
        description="Stok dan nilai yang ditambahkan oleh pembelian ini akan dibalik. Hanya bisa dilakukan jika belum ada pergerakan stok lain sesudahnya."
        confirmLabel="Batalkan"
        confirmVariant="danger"
        onConfirm={handleConfirm}
        loading={pending}
      >
        {error && (
          <p role="alert" className="text-base text-danger-700">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}

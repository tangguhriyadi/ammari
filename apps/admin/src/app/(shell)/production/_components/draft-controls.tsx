"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Dialog } from "@ammari/ui";
import { deleteDraftAction, postBatchAction } from "../actions";

export function DraftControls({ batchId, canPost }: { batchId: string; canPost: boolean }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState<"post" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handlePost() {
    setError(null);
    startTransition(async () => {
      const result = await postBatchAction({ id: batchId });
      setConfirmOpen(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteDraftAction({ id: batchId });
      setConfirmOpen(null);
      // Success redirects to /production from the server (deleteDraftAction), so only a failure
      // returns here.
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => setConfirmOpen("delete")}>
          Hapus draf
        </Button>
        {canPost && (
          <Button type="button" onClick={() => setConfirmOpen("post")}>
            Posting batch
          </Button>
        )}
      </div>

      <Dialog
        open={confirmOpen === "post"}
        onOpenChange={(open) => !open && setConfirmOpen(null)}
        title="Posting batch ini?"
        description="Bahan dan aksesoris dipakai dan HPP per pcs dihitung. Stok barang jadi belum bertambah: hasil jahitan masuk stok saat diterima lewat Terima hasil. Batch tidak bisa diubah lagi setelah diposting."
        confirmLabel="Posting"
        onConfirm={handlePost}
        loading={pending}
      />
      <Dialog
        open={confirmOpen === "delete"}
        onOpenChange={(open) => !open && setConfirmOpen(null)}
        title="Hapus draf ini?"
        description="Draf dan semua barisnya akan dihapus permanen. Tindakan ini tidak bisa dibatalkan."
        confirmLabel="Hapus"
        confirmVariant="danger"
        onConfirm={handleDelete}
        loading={pending}
      />
    </div>
  );
}

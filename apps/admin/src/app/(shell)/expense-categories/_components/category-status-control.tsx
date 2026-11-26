"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Dialog, useToast } from "@ammari/ui";
import { setExpenseCategoryActiveAction } from "../actions";
import { SYSTEM_BADGE_HINT_INLINE } from "./system-badge";

/** "Nonaktifkan" / "Aktifkan" for one category. A system category gets neither, only the reason;
 * the server refuses it anyway (plan §3.2). */
export function CategoryStatusControl({ code, name, isActive, isSystem }: { code: string; name: string; isActive: boolean; isSystem: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (isSystem) {
    return <p className="text-sm text-neutral-600">Kategori sistem: {SYSTEM_BADGE_HINT_INLINE}.</p>;
  }

  function setActive(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setExpenseCategoryActiveAction({ code, isActive: next });
      setConfirmOpen(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(next ? `Kategori ${name} diaktifkan` : `Kategori ${name} dinonaktifkan`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {isActive ? (
        <Button type="button" variant="secondary" onClick={() => setConfirmOpen(true)} disabled={pending}>
          Nonaktifkan kategori
        </Button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setActive(true)} loading={pending}>
          Aktifkan kategori
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Dialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!pending) setConfirmOpen(next);
        }}
        title={`Nonaktifkan ${name}?`}
        description="Kategori ini tidak bisa dipilih untuk biaya baru. Biaya dan laporan yang sudah memakainya tidak berubah. Bisa diaktifkan lagi kapan saja."
        confirmLabel="Nonaktifkan"
        onConfirm={() => setActive(false)}
        loading={pending}
      />
    </div>
  );
}

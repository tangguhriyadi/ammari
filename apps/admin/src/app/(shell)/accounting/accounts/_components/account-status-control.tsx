"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Dialog, useToast } from "@ammari/ui";
import { deleteAccountAction, setAccountActiveAction } from "../actions";

// "Nonaktifkan" / "Aktifkan" and "Hapus" for one account. A system account gets neither, only the
// reason; delete is offered only for an account nothing uses. The server re-checks everything.

export function AccountStatusControl({
  code,
  name,
  isActive,
  isSystem,
  canDelete,
}: {
  code: string;
  name: string;
  isActive: boolean;
  isSystem: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<"deactivate" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (isSystem) {
    return <p className="text-sm text-neutral-600">Akun sistem dipakai jurnal otomatis: bisa diganti nama, tapi tidak bisa dinonaktifkan atau dihapus.</p>;
  }

  function setActive(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setAccountActiveAction({ code, isActive: next });
      setDialog(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(next ? `Akun ${name} diaktifkan` : `Akun ${name} dinonaktifkan`);
      router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteAccountAction(code);
      setDialog(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`Akun ${name} dihapus`);
      router.push("/accounting/accounts");
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-3">
        {isActive ? (
          <Button type="button" variant="secondary" onClick={() => setDialog("deactivate")} disabled={pending}>
            Nonaktifkan akun
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setActive(true)} loading={pending}>
            Aktifkan akun
          </Button>
        )}
        {canDelete && (
          <Button type="button" variant="secondary" onClick={() => setDialog("delete")} disabled={pending}>
            Hapus akun
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Dialog
        open={dialog === "deactivate"}
        onOpenChange={(next) => {
          if (!pending && !next) setDialog(null);
        }}
        title={`Nonaktifkan ${name}?`}
        description="Akun ini tidak bisa dipilih untuk pemetaan dan jurnal baru. Jurnal yang sudah ada tidak berubah. Bisa diaktifkan lagi kapan saja."
        confirmLabel="Nonaktifkan"
        onConfirm={() => setActive(false)}
        loading={pending}
      />
      <Dialog
        open={dialog === "delete"}
        onOpenChange={(next) => {
          if (!pending && !next) setDialog(null);
        }}
        title={`Hapus ${name}?`}
        description="Akun ini belum pernah dipakai, jadi bisa dihapus. Kode akunnya bisa dipakai lagi."
        confirmLabel="Hapus"
        onConfirm={remove}
        loading={pending}
      />
    </div>
  );
}

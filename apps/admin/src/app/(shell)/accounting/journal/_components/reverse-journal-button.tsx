"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button, Dialog, Label, Textarea, useToast } from "@ammari/ui";
import { MAX_REVERSAL_REASON_LENGTH } from "@/lib/accounting/manual-journal-input";
import { reverseJournalAction } from "../actions";

// "Balik" for a manual or opening journal (docs/plans/accounting.md §7: never edited, a wrong one is
// reversed and entered again). The reason is required; the server re-checks permission and state.

export function ReverseJournalButton({ entryId, entryNo }: { entryId: string; entryNo: string }) {
  const router = useRouter();
  const toast = useToast();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openDialog() {
    setError(null);
    setReasonError(null);
    setOpen(true);
  }

  function confirm() {
    setError(null);
    setReasonError(null);
    startTransition(async () => {
      const result = await reverseJournalAction({ id: entryId, reason });
      if (!result.ok) {
        // A reason problem goes under the field; anything else (e.g. already reversed) above it.
        if (result.fieldErrors?.reason) setReasonError(result.fieldErrors.reason);
        else setError(result.error);
        return;
      }
      setOpen(false);
      setReason("");
      toast.success(`${entryNo} dibalik dengan ${result.data.entryNo}`);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={openDialog} aria-label={`Balik jurnal ${entryNo}`}>
        Balik
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
        title={`Balik jurnal ${entryNo}?`}
        description="Jurnal pembalik dibuat dengan debit dan kredit ditukar. Jurnal asli tetap tercatat. Bila bulannya sudah ditutup, pembalik masuk ke bulan pertama yang masih terbuka."
        confirmLabel="Balik jurnal"
        onConfirm={confirm}
        loading={pending}
      >
        <div className="flex flex-col gap-1.5">
          {error && (
            <p role="alert" className="text-sm text-danger-700">
              {error}
            </p>
          )}
          <Label htmlFor={reasonId} required>
            Alasan
          </Label>
          <Textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={MAX_REVERSAL_REASON_LENGTH} disabled={pending} error={reasonError ?? undefined} />
        </div>
      </Dialog>
    </>
  );
}

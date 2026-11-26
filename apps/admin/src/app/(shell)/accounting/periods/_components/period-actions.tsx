"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button, Dialog, Label, Textarea, useToast } from "@ammari/ui";
import { MAX_PERIOD_REASON_LENGTH } from "@/lib/accounting/period-rules";
import { closePeriodAction, reopenPeriodAction } from "../actions";

// "Tutup bulan" / "Buka kembali" for one month (docs/plans/accounting.md §7, D-23). Closing asks for
// a reason only while the month still has open posting issues; reopening always does. The server
// re-checks permission (accounting.close) and every rule.

export function PeriodActions({ month, label, status, openIssueCount, closeRefusal }: { month: string; label: string; status: "open" | "closed"; openIssueCount: number; closeRefusal: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const closing = status === "open";

  if (closing && closeRefusal) return <p className="text-sm text-neutral-600">{closeRefusal}</p>;

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = closing ? await closePeriodAction({ month, overrideReason: reason }) : await reopenPeriodAction({ month, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setReason("");
      toast.success(closing ? `${label} ditutup` : `${label} dibuka kembali`);
      router.refresh();
    });
  }

  const needsReason = !closing || openIssueCount > 0;
  return (
    <>
      <Button
        type="button"
        variant={closing ? "primary" : "secondary"}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-label={closing ? `Tutup bulan ${label}` : `Buka kembali ${label}`}
      >
        {closing ? "Tutup bulan" : "Buka kembali"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
        title={closing ? `Tutup ${label}?` : `Buka kembali ${label}?`}
        description={
          closing
            ? "Setelah ditutup, tidak ada jurnal baru di bulan ini. Koreksi yang datang belakangan masuk ke bulan pertama yang masih terbuka."
            : "Jurnal bisa dibuat lagi di bulan ini. Alasan disimpan dan tercatat di log aktivitas."
        }
        confirmLabel={closing ? "Tutup bulan" : "Buka kembali"}
        onConfirm={confirm}
        loading={pending}
      >
        {needsReason ? (
          <div className="flex flex-col gap-1.5">
            {closing && <p className="text-sm text-danger-700">Masih ada {openIssueCount} sumber yang belum bisa dibukukan. Tulis alasan untuk tetap menutup.</p>}
            <Label htmlFor={reasonId} required>
              Alasan
            </Label>
            <Textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={MAX_PERIOD_REASON_LENGTH} disabled={pending} error={error ?? undefined} />
          </div>
        ) : (
          error && (
            <p role="alert" className="text-sm text-danger-700">
              {error}
            </p>
          )
        )}
      </Dialog>
    </>
  );
}

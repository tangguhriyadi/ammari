"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Input, Label } from "@ammari/ui";
import { formatDate } from "@ammari/ui/lib";
import { confirmTikTokBackfillAction, startTikTokBackfillAction } from "../actions";

// "Ambil riwayat" and "Terapkan riwayat" (docs/plans/tiktok-shop-integration.md T9). Both ask for
// confirmation; the server re-checks integrations.manage, refuses a date before 1 Dec 2026, and
// audits the change. Reading history never writes an admin order or stock; applying it waits for the
// preview and for "Mulai terapkan pesanan".

type Mode = { kind: "start"; defaultDate: string; minDate: string; maxDate: string } | { kind: "confirm"; enrich: number; create: number; held: number; applyEnabled: boolean };

/** "1 Des 2026" for a "YYYY-MM-DD" Jakarta day; the raw value while it is incomplete. */
function dayLabel(value: string): string {
  const date = new Date(`${value}T00:00:00+07:00`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) ? formatDate(date) : value;
}

const NETWORK_ERROR = "Belum bisa menyimpan. Periksa koneksi lalu coba lagi.";

export function TikTokBackfillActions({ mode, disabled = false }: { mode: Mode; disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(mode.kind === "start" ? mode.defaultDate : "");
  const [pending, startTransition] = useTransition();
  // "YYYY-MM-DD" compares as text. Before 2 Dec 2026 no day can be chosen yet (min > max).
  const outOfRange = mode.kind === "start" && (!fromDate || fromDate < mode.minDate || fromDate > mode.maxDate);

  function confirm() {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof confirmTikTokBackfillAction>>;
      try {
        result = mode.kind === "start" ? await startTikTokBackfillAction({ fromDate }) : await confirmTikTokBackfillAction();
      } catch {
        setError(NETWORK_ERROR);
        setOpen(false);
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

  const description =
    mode.kind === "start"
      ? `Pesanan, retur, laporan keuangan, dan pencairan TikTok sejak ${dayLabel(fromDate)} dibaca bertahap setiap 5 menit. Belum ada pesanan atau stok yang berubah. Setelah selesai, cek pratinjaunya dulu.`
      : `${mode.enrich} pesanan manual akan dilengkapi (tanggal kirim TikTok, status, nomor), ${mode.create} pesanan dibuat baru dan stoknya dikurangi, ${mode.held} tetap ditahan sampai dicek.${mode.applyEnabled ? "" : " Penerapan pesanan TikTok belum aktif: perubahan baru terjadi setelah Mulai terapkan pesanan."}`;

  return (
    <div className="flex flex-col gap-2">
      {mode.kind === "start" && (
        <div className="flex flex-col gap-1 sm:max-w-xs">
          <Label htmlFor="tiktok-backfill-from" required>
            Ambil riwayat sejak
          </Label>
          <Input
            id="tiktok-backfill-from"
            type="date"
            value={fromDate}
            min={mode.minDate}
            max={mode.maxDate}
            aria-describedby="tiktok-backfill-from-hint"
            onChange={(event) => {
              setFromDate(event.target.value);
              setError(null);
            }}
          />
          <p id="tiktok-backfill-from-hint" className="text-sm text-neutral-600">
            {mode.minDate > mode.maxDate ? `Bisa dimulai setelah ${dayLabel(mode.minDate)} berlalu.` : `Antara ${dayLabel(mode.minDate)} dan ${dayLabel(mode.maxDate)}.`}
          </p>
        </div>
      )}
      <Button variant="primary" className="self-start" disabled={disabled || pending || outOfRange} loading={pending} onClick={() => setOpen(true)}>
        {mode.kind === "start" ? "Ambil riwayat" : "Terapkan riwayat"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => !next && setOpen(false)}
        title={mode.kind === "start" ? "Ambil riwayat TikTok?" : "Terapkan riwayat TikTok?"}
        description={description}
        confirmLabel={mode.kind === "start" ? "Ambil riwayat" : "Terapkan"}
        confirmVariant="primary"
        loading={pending}
        onConfirm={confirm}
      />
    </div>
  );
}

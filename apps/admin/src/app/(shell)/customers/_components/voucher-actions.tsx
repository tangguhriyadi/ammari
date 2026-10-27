"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Input, Label, Textarea, useToast } from "@ammari/ui";
import { MAX_VOUCHER_REASON_LENGTH } from "@/lib/customers/consent-options";
import { extendVoucherAction, voidVoucherAction } from "../actions";

// "Batalkan" and "Perpanjang" on one voucher (docs/plans/growth.md §9.3, owner answer A8): only
// rendered for vouchers.void, always with a reason; the server re-checks the key and decides with
// one conditional UPDATE (a checkout can win the race; its message then comes back here). Both
// the phone card and the desktop row render these for the same voucher, so ids come from useId.

function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} required>
        Alasan
      </Label>
      <Textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={3} maxLength={MAX_VOUCHER_REASON_LENGTH} />
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-base text-danger-700">
      {error}
    </p>
  ) : null;
}

export function VoidVoucherButton({ voucherId, label }: { voucherId: string; label: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const reasonId = useId();

  function handleConfirm() {
    setError(null);
    if (reason.trim() === "") {
      setError("Alasan wajib diisi.");
      return;
    }
    startTransition(async () => {
      const result = await voidVoucherAction({ id: voucherId, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success("Voucher dibatalkan");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={`Batalkan voucher ${label}`}
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        Batalkan
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Batalkan voucher ${label}?`}
        description="Voucher tidak bisa dipakai lagi dan tetap tercatat sebagai Dibatalkan. Tidak bisa diulang."
        confirmLabel="Batalkan voucher"
        confirmVariant="danger"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <div className="flex flex-col gap-3">
          <ReasonField id={reasonId} value={reason} onChange={setReason} />
          <ErrorLine error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function ExtendVoucherButton({ voucherId, label, minDate, maxDate }: { voucherId: string; label: string; minDate: string; maxDate: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dateId = useId();
  const reasonId = useId();

  function handleConfirm() {
    setError(null);
    if (date === "") {
      setError("Pilih tanggal berlaku baru.");
      return;
    }
    if (reason.trim() === "") {
      setError("Alasan wajib diisi.");
      return;
    }
    startTransition(async () => {
      const result = await extendVoucherAction({ id: voucherId, newExpiryDate: date, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success("Voucher diperpanjang");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={`Perpanjang voucher ${label}`}
        onClick={() => {
          setDate("");
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        Perpanjang
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Perpanjang voucher ${label}?`}
        description="Voucher berlaku sampai akhir tanggal yang dipilih (23.59 WIB), paling lama 3 bulan dari hari ini."
        confirmLabel="Perpanjang voucher"
        onConfirm={handleConfirm}
        loading={pending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={dateId} required>
              Berlaku sampai
            </Label>
            <Input id={dateId} type="date" value={date} min={minDate} max={maxDate} onChange={(event) => setDate(event.target.value)} />
          </div>
          <ReasonField id={reasonId} value={reason} onChange={setReason} />
          <ErrorLine error={error} />
        </div>
      </Dialog>
    </>
  );
}

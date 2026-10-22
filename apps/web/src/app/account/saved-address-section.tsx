"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button, Card, Dialog } from "@ammari/ui";
import { failedCallMessage } from "@/lib/stale-deployment";
import type { SavedAddressSummary } from "@/lib/account/saved-address";
import { SAVED_ADDRESS_DELETE_FAILED_MESSAGE } from "@/lib/account/saved-address-messages";
import { deleteSavedAddressAction } from "./saved-address-actions";

const EMPTY_NOTE = "Belum ada alamat tersimpan. Alamat pengiriman tersimpan otomatis saat kamu memesan sambil masuk ke akun.";

/** "Alamat tersimpan" on /account: the saved default address with "Hapus alamat" behind a confirm
 * dialog, or a note that the next logged-in order saves one (no form here). `showWhenEmpty` is the
 * cart flag: with it off the section appears only while an address exists, so a rollback never
 * hides a buyer's data; once deleted here it stays to confirm the deletion. */
export function SavedAddressSection({ address, showWhenEmpty }: { address: SavedAddressSummary | null; showWhenEmpty: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  // The action refreshes the page too, so `address` turns null in the same answer. An address that
  // arrives later (an order from another tab, then a refresh) shows again.
  const [lastAddress, setLastAddress] = useState(address);
  if (address !== lastAddress) {
    setLastAddress(address);
    if (address) setDeleted(false);
  }
  const shown = deleted ? null : address;

  // The button disappears with the address: focus moves to the confirmation so it is not lost.
  useEffect(() => {
    if (deleted) statusRef.current?.focus();
  }, [deleted]);

  if (!shown && !showWhenEmpty && !deleted) return null;

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteSavedAddressAction();
        if (result.ok) {
          setOpen(false);
          setDeleted(true);
        } else {
          setError(result.message);
        }
      } catch (caught) {
        console.warn("[account] saved address delete did not answer", caught instanceof Error ? caught.name : typeof caught);
        setError(failedCallMessage(caught, SAVED_ADDRESS_DELETE_FAILED_MESSAGE));
      }
    });
  };

  return (
    <section className="flex flex-col gap-3" data-testid="account-saved-address" aria-labelledby="saved-address-heading">
      <h2 id="saved-address-heading" className="text-lg font-semibold text-neutral-900">
        Alamat tersimpan
      </h2>
      {deleted && (
        <p ref={statusRef} tabIndex={-1} role="status" className="text-sm text-neutral-700 focus:outline-none">
          Alamat tersimpan sudah dihapus.
        </p>
      )}
      {shown ? (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5 text-sm text-neutral-700" data-testid="account-saved-address-card">
            <p className="font-medium text-neutral-900">{shown.recipientName}</p>
            <p>{shown.phone}</p>
            <p>{shown.addressLine}</p>
            <p>{shown.areaLabel}</p>
            {shown.notes && <p className="text-xs text-neutral-500">Catatan untuk kurir: {shown.notes}</p>}
          </div>
          <p className="text-xs text-neutral-500">Dipakai untuk mengisi alamat saat checkout. Alamat diperbarui setiap kali kamu memesan sambil masuk ke akun.</p>
          <Button
            ref={deleteButtonRef}
            variant="secondary"
            className="self-start"
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            Hapus alamat
          </Button>
        </Card>
      ) : (
        // Flag off there is no checkout to save one, so no note after a deletion either.
        showWhenEmpty && <p className="text-sm text-neutral-600">{EMPTY_NOTE}</p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            // An error belongs to the attempt in the dialog; closing it starts clean.
            setError(null);
            requestAnimationFrame(() => deleteButtonRef.current?.focus());
          }
        }}
        title="Hapus alamat tersimpan?"
        description="Alamat ini tidak diisi otomatis lagi saat checkout. Pesanan yang sudah dibuat tetap memakai alamatnya sendiri."
        confirmLabel="Hapus"
        confirmVariant="danger"
        onConfirm={confirmDelete}
        loading={pending}
      >
        {error && (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        )}
      </Dialog>
    </section>
  );
}

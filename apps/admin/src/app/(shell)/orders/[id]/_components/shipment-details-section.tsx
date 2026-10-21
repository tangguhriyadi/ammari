"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@ammari/ui";
import { ShipmentDetailsDialog } from "@/components/orders/shipment-details-dialog";
import { updateShipmentDetailsAction } from "../../actions";

export interface ShipmentDetailsSectionProps {
  orderId: string;
  orderNo: string;
  courier: string | null;
  trackingNumber: string | null;
  /** A web checkout order: both required, and its buyer's "sudah dikirim" email waits for the resi. */
  isCheckout: boolean;
  canManage: boolean;
}

/** Courier and resi of a shipped order, with "Tambah resi" / "Ubah resi" (2026-10-21 sandbox run: a
 * web order had shipped without a resi and its buyer could not track it). */
export function ShipmentDetailsSection({ orderId, orderNo, courier, trackingNumber, isCheckout, canManage }: ShipmentDetailsSectionProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // A fresh dialog per opening, starting from the values on the page.
  const [dialogKey, setDialogKey] = useState(0);

  return (
    <section aria-label="Resi" className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <h2 className="text-lg font-semibold text-neutral-900">Resi</h2>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-neutral-600">Kurir</span>
        <span className="text-base text-neutral-900">{courier ?? "-"}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-neutral-600">No. resi</span>
        <span className="text-base text-neutral-900">{trackingNumber ?? "-"}</span>
      </div>
      {isCheckout && !trackingNumber && (
        <p role="status" className="text-sm text-danger-700">
          Belum ada nomor resi. Pembeli baru mendapat email &quot;sudah dikirim&quot; setelah nomor resi diisi.
        </p>
      )}
      {canManage && (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          onClick={() => {
            setDialogKey((current) => current + 1);
            setOpen(true);
          }}
        >
          {trackingNumber ? "Ubah resi" : "Tambah resi"}
        </Button>
      )}
      {canManage && (
        <ShipmentDetailsDialog
          key={dialogKey}
          title={`${trackingNumber ? "Ubah resi" : "Tambah resi"}: ${orderNo}`}
          description={isCheckout && trackingNumber ? "Pembeli yang sudah menerima email tidak mendapat email baru; nomor resi terbaru tampil di halaman pesanannya." : undefined}
          confirmLabel="Simpan"
          checkoutOrder={isCheckout}
          defaultCourier={courier}
          defaultTrackingNumber={trackingNumber}
          open={open}
          onOpenChange={setOpen}
          submit={(values) => updateShipmentDetailsAction({ orderId, ...values })}
          onDone={() => {
            toast.success("Resi tersimpan.");
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

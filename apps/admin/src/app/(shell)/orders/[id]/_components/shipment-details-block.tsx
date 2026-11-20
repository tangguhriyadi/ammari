"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@ammari/ui";
import { ShipmentDetailsDialog } from "@/components/orders/shipment-details-dialog";
import { CopyValue } from "@/components/orders/copy-value";
import { DetailList, DetailRow } from "./section-card";
import { updateShipmentDetailsAction } from "../../actions";

export interface ShipmentDetailsBlockProps {
  orderId: string;
  orderNo: string;
  courier: string | null;
  trackingNumber: string | null;
  /** A web checkout order: both required, and its buyer's "sudah dikirim" email waits for the resi. */
  isCheckout: boolean;
  /** The courier booking's waybill (Phase K2): a different resi is warned about and flagged. */
  bookedWaybill?: string | null;
  canManage: boolean;
  /** Hide the "Kurir" row when it only repeats the quoted service shown just above. */
  hideCourier?: boolean;
}

/** Courier and resi of a shipped order, with "Tambah resi" / "Ubah resi" (2026-10-21 sandbox run: a
 * web order had shipped without a resi and its buyer could not track it). Lives inside the
 * "Pengiriman" card, for web and for manual or marketplace orders alike. */
export function ShipmentDetailsBlock({ orderId, orderNo, courier, trackingNumber, isCheckout, bookedWaybill, canManage, hideCourier = false }: ShipmentDetailsBlockProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // A fresh dialog per opening, starting from the values on the page.
  const [dialogKey, setDialogKey] = useState(0);

  return (
    <div className="flex flex-col gap-3">
      <DetailList>
        {!hideCourier && <DetailRow label="Kurir" value={courier ?? "-"} />}
        <DetailRow
          label="No. resi"
          value={trackingNumber ? <CopyValue value={trackingNumber} label="nomor resi pesanan" testId="order-tracking-number" /> : "-"}
        />
      </DetailList>
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
          bookedWaybill={bookedWaybill}
          open={open}
          onOpenChange={setOpen}
          submit={(values) => updateShipmentDetailsAction({ orderId, ...values })}
          onDone={() => {
            toast.success("Resi tersimpan.");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

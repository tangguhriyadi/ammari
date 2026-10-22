"use client";

import { useId, useState, useTransition } from "react";
import { Dialog, Input, Label, type ButtonVariant } from "@ammari/ui";
import { parseShipmentDetails } from "@ammari/commerce/shipment-details";
import type { ActionResult } from "@/lib/action-result";

const COURIER_SUGGESTIONS = ["JNE", "J&T", "SiCepat", "AnterAja", "Ninja Xpress", "ID Express", "POS Indonesia", "Lion Parcel"];

const UNEXPECTED_ERROR = "Terjadi kesalahan. Coba lagi.";

export interface ShipmentDetailsDialogProps {
  title: string;
  description?: string;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  /** A web checkout order: courier and resi are both required (@ammari/commerce/shipment-details);
   * the server checks again under the order's row lock. */
  checkoutOrder: boolean;
  defaultCourier?: string | null;
  defaultTrackingNumber?: string | null;
  /** The waybill of the order's courier booking (Phase K2): prefills the resi when there is none,
   * and a different resi is warned about (the server flags it `tracking_number_mismatch`). */
  bookedWaybill?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submit: (values: { courier: string; trackingNumber: string }) => Promise<ActionResult<unknown>>;
  onDone: () => void;
}

/** The courier and resi form, shared by packing's per-order "Tandai dikirim" and the order page's
 * "Dikirim" / "Tambah resi" / "Ubah resi" (2026-10-21 sandbox run: a web order shipped without a
 * resi). Mount it with a `key` per order so a reopened dialog starts from that order's values. */
export function ShipmentDetailsDialog({
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  checkoutOrder,
  defaultCourier,
  defaultTrackingNumber,
  bookedWaybill,
  open,
  onOpenChange,
  submit,
  onDone,
}: ShipmentDetailsDialogProps) {
  const [courier, setCourier] = useState(defaultCourier ?? "");
  const [trackingNumber, setTrackingNumber] = useState(defaultTrackingNumber ?? bookedWaybill ?? "");
  const typedResi = trackingNumber.replace(/\s+/g, "").toUpperCase();
  const differsFromBooking = Boolean(bookedWaybill) && typedResi !== "" && typedResi !== bookedWaybill!.replace(/\s+/g, "").toUpperCase();
  const [fieldErrors, setFieldErrors] = useState<{ courier?: string; trackingNumber?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const idPrefix = useId();
  const courierId = `${idPrefix}-courier`;
  const trackingId = `${idPrefix}-tracking`;
  const suggestionsId = `${idPrefix}-couriers`;

  function handleConfirm() {
    if (pending) return;
    setError(null);
    const parsed = parseShipmentDetails({ courier, trackingNumber }, { checkoutOrder });
    if (!parsed.ok) {
      setFieldErrors(Object.fromEntries(parsed.errors.map((issue) => [issue.field, issue.message])));
      return;
    }
    setFieldErrors({});
    startTransition(async () => {
      let result: ActionResult<unknown>;
      try {
        result = await submit({ courier, trackingNumber });
      } catch (callError) {
        // Offline, or a deploy in between: an error line, never the error screen.
        console.error("[orders] shipment details call failed", callError);
        setError(UNEXPECTED_ERROR);
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      onDone();
    });
  }

  const placeholder = checkoutOrder ? undefined : "Opsional";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      confirmVariant={confirmVariant}
      onConfirm={handleConfirm}
      loading={pending}
    >
      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor={courierId}>Kurir{checkoutOrder ? "" : " (opsional)"}</Label>
          <Input
            id={courierId}
            list={suggestionsId}
            value={courier}
            onChange={(event) => setCourier(event.target.value)}
            placeholder={placeholder}
            required={checkoutOrder}
            maxLength={60}
            error={fieldErrors.courier}
          />
          <datalist id={suggestionsId}>
            {COURIER_SUGGESTIONS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div>
          <Label htmlFor={trackingId}>No. resi{checkoutOrder ? "" : " (opsional)"}</Label>
          <Input
            id={trackingId}
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
            placeholder={placeholder}
            required={checkoutOrder}
            autoComplete="off"
            maxLength={checkoutOrder ? 60 : 100}
            error={fieldErrors.trackingNumber}
          />
          {checkoutOrder && <p className="mt-1 text-sm text-neutral-600">Pesanan website: nomor resi wajib, dikirim ke pembeli lewat email.</p>}
          {bookedWaybill && <p className="mt-1 text-sm text-neutral-600">Resi dari pemesanan kurir: {bookedWaybill}</p>}
          {differsFromBooking && (
            <p role="status" className="mt-1 text-sm text-danger-700">
              Nomor resi ini berbeda dengan resi dari pemesanan kurir. Pesanan akan ditandai Perlu dicek.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-base text-danger-700">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

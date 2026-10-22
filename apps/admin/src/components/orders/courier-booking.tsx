"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Label, Select, useToast } from "@ammari/ui";
import type { ShipmentStatus } from "@ammari/db/schema";
import type { ShipmentActionOutcome, ShipmentCancelReasonCode } from "@ammari/commerce/shipping";
import type { ActionResult } from "@/lib/action-result";
import { downloadOrOpenPdf, openStickerPopupPlaceholder } from "@/lib/client/pdf-download";
import { bookShipmentAction, cancelShipmentAction, printShippingLabelAction, recheckBookingAction, type ShippingLabelResult } from "@/app/(shell)/orders/shipment-actions";

// "Pesan kurir", "Cek ulang pemesanan", "Batalkan pengiriman" and "Cetak label" for a paid web order
// (docs/plans/cart-checkout.md §15 Phase K, K2), on the /packing row and in the order page's
// "Pengiriman" section. Every action is checked again on the server (orders.manage, the order's
// state under its row lock); these buttons only offer what fits the state the page was rendered with.

const UNEXPECTED_ERROR = "Terjadi kesalahan. Coba lagi.";

const CANCEL_REASONS: { value: ShipmentCancelReasonCode; label: string }[] = [
  { value: "others", label: "Lainnya" },
  { value: "change_courier", label: "Ganti kurir" },
  { value: "pickup_delay", label: "Penjemputan terlambat" },
  { value: "change_address", label: "Ganti alamat" },
];

export interface LiveShipmentSummary {
  status: ShipmentStatus;
  awb: string | null;
}

export interface CourierBookingProps {
  orderId: string;
  orderNo: string;
  /** The live attempt (not cancelled or failed), or null. */
  shipment: LiveShipmentSummary | null;
  /** `row`: /packing (book, check, label). `section`: the order page (also cancel). */
  variant: "row" | "section";
  /** Disabled while the surrounding page runs another action on the same order. */
  disabled?: boolean;
}

async function call<T>(action: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await action();
  } catch (error) {
    // Offline, or a deploy in between: an error line, never the error screen.
    console.error("[shipping] courier action failed to reach the server", error);
    return { ok: false, error: UNEXPECTED_ERROR };
  }
}

function outcomeMessage(outcome: ShipmentActionOutcome): { kind: "success" | "error"; text: string } {
  switch (outcome.outcome) {
    case "booked":
      return { kind: "success", text: outcome.awb ? `Kurir dipesan. Resi ${outcome.awb}.` : "Kurir dipesan. Resi belum ada, tekan Cek ulang pemesanan sebentar lagi." };
    case "already_booked":
      return { kind: "success", text: "Kurir untuk pesanan ini sudah dipesan." };
    case "cancelled":
      return { kind: "success", text: "Pengiriman dibatalkan. Kurir bisa dipesan lagi." };
    case "pending":
      return outcome.manualCheck
        ? { kind: "error", text: `Pemesanan belum bisa dipastikan otomatis. Cek referensi ${outcome.referenceId} di dashboard Biteship. Kalau perlu, kirim lewat jalur manual dan isi nomor resinya.` }
        : { kind: "error", text: "Jawaban Biteship belum diterima, kurir mungkin sudah dipesan. Tekan Cek ulang pemesanan sebentar lagi." };
  }
}

/** Remounted once a booking settles (or its waybill changes), so a "belum pasti" message never
 * outlives the booking it was about; it survives the refresh that shows the unsettled attempt. */
export function CourierBooking(props: CourierBookingProps) {
  const settled = props.shipment !== null && props.shipment.status !== "booking";
  return <CourierBookingControls key={settled ? `booked:${props.shipment!.awb ?? ""}` : "open"} {...props} />;
}

/** Hands the PDF to the browser; a failure is a message, never the error screen. */
function safeDownload(pdfBase64: string, filename: string, popup: Window | null): string | null {
  try {
    return downloadOrOpenPdf(pdfBase64, filename, popup);
  } catch (error) {
    popup?.close();
    console.error("[shipping] label download failed", error);
    return "Label tidak bisa dibuka. Coba lagi.";
  }
}

function CourierBookingControls({ orderId, orderNo, shipment, variant, disabled = false }: CourierBookingProps) {
  const router = useRouter();
  const toast = useToast();
  const reasonId = useId();
  const [busy, setBusy] = useState<"book" | "recheck" | "cancel" | "label" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState<ShipmentCancelReasonCode>("others");
  const [labelWithWarnings, setLabelWithWarnings] = useState<ShippingLabelResult | null>(null);
  const [pending, startTransition] = useTransition();
  // Set synchronously, so a fast double tap starts one call (the disabled state follows a render later).
  const inFlight = useRef(false);

  function run(kind: "book" | "recheck" | "cancel", action: () => Promise<ActionResult<ShipmentActionOutcome>>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(kind);
    startTransition(async () => {
      const result = await call(action);
      inFlight.current = false;
      setBusy(null);
      setConfirmCancel(false);
      if (!result.ok) {
        setError(result.error);
        // A refusal may have recorded something (a failed attempt): show what is true now.
        router.refresh();
        return;
      }
      const message = outcomeMessage(result.data);
      if (message.kind === "success") toast.success(message.text);
      else setError(message.text);
      if (result.data.outcome === "booked" && result.data.overQuote) {
        toast.error("Ongkir kurir lebih mahal dari ongkir saat checkout. Pesanan ditandai Perlu dicek.");
      }
      router.refresh();
    });
  }

  function printLabel() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy("label");
    // Opened here, synchronously inside the click (iPad Safari only; see pdf-download.ts).
    const popup = openStickerPopupPlaceholder();
    startTransition(async () => {
      const result = await call(() => printShippingLabelAction({ orderId }));
      inFlight.current = false;
      setBusy(null);
      if (!result.ok) {
        popup?.close();
        setError(result.error);
        router.refresh();
        return;
      }
      if (result.data.warnings.length > 0) {
        // Shown before printing (K1 notes); the download starts from the dialog's own click.
        popup?.close();
        setLabelWithWarnings(result.data);
        return;
      }
      const downloadError = safeDownload(result.data.pdfBase64, result.data.filename, popup);
      if (downloadError) setError(downloadError);
      router.refresh();
    });
  }

  const live = shipment;
  const booked = live !== null && live.status !== "booking";
  const isBusy = pending || disabled;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {live === null && (
          <Button type="button" variant="secondary" loading={busy === "book"} disabled={isBusy} onClick={() => run("book", () => bookShipmentAction({ orderId }))}>
            Pesan kurir
          </Button>
        )}
        {live !== null && (live.status === "booking" || variant === "section") && (
          <Button type="button" variant="secondary" loading={busy === "recheck"} disabled={isBusy} onClick={() => run("recheck", () => recheckBookingAction({ orderId }))}>
            Cek ulang pemesanan
          </Button>
        )}
        {booked && live.awb && (
          <Button type="button" variant="secondary" loading={busy === "label"} disabled={isBusy} onClick={printLabel}>
            Cetak label
          </Button>
        )}
        {variant === "section" && live?.status === "pickup_requested" && (
          <Button type="button" variant="danger" loading={busy === "cancel"} disabled={isBusy} onClick={() => setConfirmCancel(true)}>
            Batalkan pengiriman
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-xs whitespace-normal text-base text-danger-700 md:max-w-sm">
          {error}
        </p>
      )}

      {variant === "section" && (
        <Dialog
          open={confirmCancel}
          onOpenChange={setConfirmCancel}
          title={`Batalkan pengiriman ${orderNo}?`}
          description="Kurir tidak jadi menjemput paket. Bisa dibatalkan hanya sebelum paket dijemput. Pesanan tetap Siap Kirim, dan kurir bisa dipesan lagi."
          confirmLabel="Batalkan pengiriman"
          cancelLabel="Kembali"
          confirmVariant="danger"
          loading={busy === "cancel"}
          onConfirm={() => run("cancel", () => cancelShipmentAction({ orderId, reasonCode: reason }))}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>Alasan</Label>
            <Select id={reasonId} value={reason} onChange={(event) => setReason(event.target.value as ShipmentCancelReasonCode)}>
              {CANCEL_REASONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        </Dialog>
      )}

      <Dialog
        open={labelWithWarnings !== null}
        onOpenChange={(open) => !open && setLabelWithWarnings(null)}
        title={`Cek label ${orderNo} dulu`}
        description="Sebagian teks di label dipotong atau diganti, cek sebelum dicetak."
        confirmLabel="Unduh label"
        cancelLabel="Kembali"
        onConfirm={() => {
          const label = labelWithWarnings;
          if (!label) return;
          const popup = openStickerPopupPlaceholder();
          setLabelWithWarnings(null);
          const downloadError = safeDownload(label.pdfBase64, label.filename, popup);
          if (downloadError) setError(downloadError);
        }}
      >
        <ul className="flex list-disc flex-col gap-1 pl-5 text-base text-neutral-700">
          {labelWithWarnings?.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

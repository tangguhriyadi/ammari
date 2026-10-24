"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Label, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { OrderAttentionFlag, OrderPaymentStatus, OrderStatus } from "@ammari/db/schema";
import { attentionFlagCopy, isKnownAttentionFlag } from "@/lib/orders/checkout-labels";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { STOREFRONT_STALE_MESSAGE } from "@/lib/storefront-stale";
import type { ActionResult } from "@/lib/action-result";
import { ShipmentDetailsDialog } from "@/components/orders/shipment-details-dialog";
import { markShippedAction } from "../../../packing/actions";
import { adoptBookedWaybillAction, cancelCheckoutOrderAction, clearAttentionFlagAction, recordRefundAction, transitionOrderStatusAction } from "../../actions";

// Staff actions on a web checkout order (docs/plans/cart-checkout.md §6.5, §7, session 16). Every
// one is checked again on the server (orders.manage, and the order's state under its row lock);
// these buttons only offer what makes sense for the state the page was rendered with.

const UNEXPECTED_ERROR = "Terjadi kesalahan. Coba lagi.";

/** Runs a server action; a call that rejects (offline, a deploy in between) reads as an error
 * message instead of throwing into the error boundary. */
async function call<T>(action: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await action();
  } catch (error) {
    console.error("[orders] checkout order action failed to reach the server", error);
    return { ok: false, error: UNEXPECTED_ERROR };
  }
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-base text-danger-700">
      {message}
    </p>
  );
}

/** After an action removes the panel or the button that had focus, focus goes to the page heading
 * so keyboard and screen-reader users keep their place. */
function focusPageHeading(): void {
  const heading = document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("h1");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus();
}

// ---------- status buttons ----------

export interface CheckoutStatusActionsProps {
  orderId: string;
  orderNo: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  totalAmount: number;
  /** Prefills "Kurir" in the "Dikirim" dialog (staff book exactly the quoted service). */
  quotedCourierLabel: string | null;
  /** The courier booking's waybill (Phase K2), prefilled as the resi. */
  bookedWaybill?: string | null;
  /** ORDER_STATUS_TRANSITIONS for the current status. */
  allowedTransitions: OrderStatus[];
  /** A courier booking reported the parcel delivered (K3): then the buyer gets "sudah sampai". */
  courierDelivered?: boolean;
  /** An open courier booking the poll still reads (it stops once staff complete the order). */
  openBooking?: boolean;
}

export function CheckoutStatusActions({ orderId, orderNo, status, paymentStatus, totalAmount, quotedCourierLabel, bookedWaybill, allowedTransitions, courierDelivered = false, openBooking = false }: CheckoutStatusActionsProps) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // "Dikirim" asks for the courier and resi first (required on a web order, 2026-10-21 sandbox run).
  const [shipping, setShipping] = useState(false);
  // "Tandai selesai" asks first: the courier has not reported the delivery (K4).
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [pending, startTransition] = useTransition();

  const unpaid = paymentStatus === "pending";
  // Money Ammari holds and gives back on a cancel (refunded or charged-back orders hold none).
  const holdsMoney = paymentStatus === "paid" || paymentStatus === "partially_refunded";
  // A cancel goes through its own action; Siap Kirim from awaiting_payment only once paid ("Proses",
  // stock short at payment). Everything later (Dikirim, Selesai, Retur) is the usual transition.
  const transitions = allowedTransitions.filter((to) => to !== "cancelled" && !(to === "to_ship" && paymentStatus !== "paid"));
  const canCancel = allowedTransitions.includes("cancelled");
  if (transitions.length === 0 && !canCancel) return null;

  function transition(toStatus: OrderStatus) {
    setError(null);
    startTransition(async () => {
      const result = await call(() => transitionOrderStatusAction({ orderId, toStatus }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.data.storefrontOk) toast.error(STOREFRONT_STALE_MESSAGE);
      // The button that had focus is gone once the order moved on.
      focusPageHeading();
      router.refresh();
    });
  }

  function cancel() {
    setError(null);
    startTransition(async () => {
      const result = await call(() => cancelCheckoutOrderAction({ orderId }));
      setConfirmCancel(false);
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      focusPageHeading();
      if (result.data.outcome === "already_cancelled") toast.success("Pesanan sudah dibatalkan.");
      else toast.success(result.data.refundDue ? "Pesanan dibatalkan. Kembalikan dana pembeli, lalu catat di bagian Perlu dicek." : "Pesanan dibatalkan.");
      if (!result.data.storefrontOk) toast.error(STOREFRONT_STALE_MESSAGE);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {transitions.map((toStatus) => (
          <Button
            key={toStatus}
            type="button"
            variant={toStatus === "returned" ? "danger" : "secondary"}
            loading={pending}
            onClick={() => (toStatus === "shipped" ? setShipping(true) : toStatus === "completed" ? setConfirmComplete(true) : transition(toStatus))}
          >
            {status === "awaiting_payment" && toStatus === "to_ship" ? "Proses" : toStatus === "completed" ? "Tandai selesai" : ORDER_STATUS_LABELS[toStatus]}
          </Button>
        ))}
        {canCancel && (
          <Button type="button" variant="danger" loading={pending} onClick={() => setConfirmCancel(true)}>
            {holdsMoney ? "Batalkan dan kembalikan dana" : "Batalkan pesanan"}
          </Button>
        )}
      </div>
      <ErrorLine message={error} />
      {shipping && (
        <ShipmentDetailsDialog
          title={`Tandai dikirim: ${orderNo}`}
          confirmLabel="Tandai dikirim"
          checkoutOrder
          defaultCourier={quotedCourierLabel}
          bookedWaybill={bookedWaybill}
          open={shipping}
          onOpenChange={setShipping}
          submit={({ courier, trackingNumber }) => markShippedAction({ orderId, courier, trackingNumber, confirmNoCard: true })}
          onDone={() => {
            toast.success("Pesanan ditandai dikirim. Pembeli mendapat email dengan nomor resi.");
            router.refresh();
          }}
        />
      )}
      <Dialog
        open={confirmComplete}
        onOpenChange={setConfirmComplete}
        title={`Tandai selesai: ${orderNo}?`}
        description={
          courierDelivered
            ? "Kurir sudah melaporkan paket sampai. Pembeli mendapat email bahwa pesanannya sudah sampai."
            : openBooking
              ? "Kurir belum melaporkan paket sampai. Tandai selesai hanya kalau kamu sudah memastikan paket diterima pembeli (misalnya lewat WhatsApp atau cek resi di situs kurir). Pembeli tidak mendapat email \"sudah sampai\", dan pengecekan otomatis berkala untuk pesanan ini berhenti."
              : "Tandai selesai kalau paket sudah diterima pembeli. Pembeli tidak mendapat email \"sudah sampai\"."
        }
        confirmLabel="Tandai selesai"
        cancelLabel="Kembali"
        onConfirm={() => {
          setConfirmComplete(false);
          transition("completed");
        }}
      />
      <Dialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={`Batalkan ${orderNo}?`}
        description={
          unpaid
            ? "Halaman pembayaran pembeli ditutup dulu di Midtrans. Kalau ternyata sudah dibayar, pesanan tidak dibatalkan. Stok yang dipesan dilepas dan voucher kembali ke pembeli. Pembeli mendapat email pembatalan. Kalau pembeli masih sempat membayar setelahnya, pesanan ditandai Perlu dicek untuk pengembalian dana."
            : !holdsMoney
              ? "Stok kembali dan voucher kembali ke pembeli. Pembeli mendapat email pembatalan."
              : `Stok kembali dan voucher kembali ke pembeli. Dana ${formatRupiah(totalAmount)} (termasuk ongkir) harus dikembalikan ke pembeli di luar aplikasi, lalu dicatat di sini. Pembeli mendapat email bahwa dananya akan dikembalikan.`
        }
        confirmLabel="Batalkan pesanan"
        cancelLabel="Kembali"
        confirmVariant="danger"
        onConfirm={cancel}
        loading={pending}
      />
    </div>
  );
}

// ---------- needs_attention flags ----------

export interface RefundableAttempt {
  paymentId: string;
  attempt: number;
  /** What is still to give back on this attempt. */
  amount: number;
}

export interface AttentionPanelProps {
  orderId: string;
  status: OrderStatus;
  flags: OrderAttentionFlag[];
  refundableAttempts: RefundableAttempt[];
  /** Money is still owed back (refundsOwed > 0): refund_due and paid_after_cancel then end only
   * with a recorded refund (the server refuses "Tandai beres" for them too). */
  refundOwed: boolean;
  canManage: boolean;
  /** The live courier booking's waybill and the order's resi (K4: "Pakai resi pesanan kurir"). */
  bookedWaybill?: string | null;
  trackingNumber?: string | null;
}

/** Flags whose facts are in the Pengiriman section (K4). */
const SHIPPING_FLAGS: ReadonlySet<string> = new Set(["tracking_stale", "delivery_problem", "tracking_number_mismatch", "shipping_cost_over_quote"]);

/** A rejected marketplace return is settled by removing its flag (docs/plans/marketplace-import.md
 * §3 rule 3a); every other flag is "Tandai beres". Audit logged on the server either way. */
function clearLabel(flag: OrderAttentionFlag): string {
  return flag === "marketplace_return_pending" ? "Hapus tanda retur" : "Tandai beres";
}

function sameResi(a: string, b: string): boolean {
  return a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
}

export function AttentionPanel({ orderId, status, flags, refundableAttempts, refundOwed, canManage, bookedWaybill = null, trackingNumber = null }: AttentionPanelProps) {
  const router = useRouter();
  const toast = useToast();
  const noteId = useId();
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState<OrderAttentionFlag | null>(null);
  // The label the clear dialog shows, kept while it closes (clearing is reset first).
  const [clearingLabel, setClearingLabel] = useState("");
  // Same for the action's name ("Hapus tanda retur" / "Tandai beres").
  const [clearingAction, setClearingAction] = useState("Tandai beres");
  /** Which button the running action belongs to (its spinner); every other button is disabled. */
  const [busy, setBusy] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<RefundableAttempt | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (flags.length === 0) return null;

  // The booking's waybill can replace a different resi once the order has shipped (the server reads
  // the waybill itself and checks every rule again).
  const canAdoptWaybill = (status === "shipped" || status === "completed") && bookedWaybill !== null && (trackingNumber === null || !sameResi(bookedWaybill, trackingNumber));

  function adoptWaybill() {
    setError(null);
    setBusy("adopt");
    startTransition(async () => {
      const result = await call(() => adoptBookedWaybillAction({ orderId }));
      setBusy(null);
      if (!result.ok) setError(result.error);
      else {
        toast.success(`Resi pesanan diganti ke ${result.data.trackingNumber}. Email "sudah dikirim" yang sudah terkirim masih berisi resi lama; halaman pesanan pembeli menampilkan resi baru.`);
        focusPageHeading();
      }
      router.refresh();
    });
  }

  function clear(flag: OrderAttentionFlag) {
    setError(null);
    setBusy(`clear:${flag}`);
    startTransition(async () => {
      const result = await call(() => clearAttentionFlagAction({ orderId, flag }));
      setClearing(null);
      setBusy(null);
      if (!result.ok) setError(result.error);
      else {
        toast.success("Tanda sudah dihapus.");
        focusPageHeading();
      }
      router.refresh();
    });
  }

  function refund(target: RefundableAttempt) {
    setNoteError(null);
    if (note.trim().length < 3) {
      setNoteError("Tulis catatan pengembalian dana, misalnya bank dan tanggal transfer.");
      return;
    }
    setBusy(`refund:${target.paymentId}`);
    startTransition(async () => {
      const result = await call(() => recordRefundAction({ orderId, paymentId: target.paymentId, note }));
      setBusy(null);
      if (!result.ok) {
        setNoteError(result.error);
        // The order may have moved on (refunded by someone else): show what is true now.
        router.refresh();
        return;
      }
      setRefunding(null);
      setNote("");
      toast.success(`Pengembalian dana ${formatRupiah(result.data.amount)} sudah dicatat.`);
      focusPageHeading();
      router.refresh();
    });
  }

  return (
    <section aria-label="Perlu dicek" className="flex flex-col gap-3 rounded-lg border border-danger-700/40 bg-danger-50 p-4">
      <h2 className="text-lg font-semibold text-neutral-900">Perlu dicek</h2>
      <ul className="flex flex-col gap-3">
        {flags.map((flag) => {
          const copy = attentionFlagCopy(flag);
          // A flag this build does not know (rollback) is shown but cannot be cleared from here.
          const clearable =
            isKnownAttentionFlag(flag) &&
            !(flag === "stock_short_at_payment" && status === "awaiting_payment") && !((flag === "refund_due" || flag === "paid_after_cancel") && refundOwed);
          return (
            <li key={flag} className="flex flex-col gap-2 rounded-md bg-white p-3">
              <p className="text-base font-semibold text-neutral-900">{copy.label}</p>
              <p className="text-base text-neutral-700">{copy.meaning}</p>
              {SHIPPING_FLAGS.has(flag) && (
                <a href="#pengiriman" className="inline-flex min-h-11 items-center self-start text-sm text-neutral-900 underline underline-offset-4">
                  Lihat bagian Pengiriman
                </a>
              )}
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  {flag === "tracking_number_mismatch" && canAdoptWaybill && (
                    <Button type="button" loading={pending && busy === "adopt"} disabled={pending} onClick={adoptWaybill}>
                      Pakai resi pesanan kurir ({bookedWaybill})
                    </Button>
                  )}
                  {flag === "refund_due" &&
                    refundableAttempts.map((target) => (
                      <Button
                        key={target.paymentId}
                        type="button"
                        loading={pending && busy === `refund:${target.paymentId}`}
                        disabled={pending}
                        onClick={() => {
                          setNote("");
                          setNoteError(null);
                          setRefunding(target);
                        }}
                      >
                        {refundableAttempts.length > 1 ? `Catat dana dikembalikan (percobaan ${target.attempt})` : "Catat dana dikembalikan"}
                      </Button>
                    ))}
                  {clearable && (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={pending && busy === `clear:${flag}`}
                      disabled={pending}
                      onClick={() => {
                        setClearingLabel(copy.label);
                        setClearingAction(clearLabel(flag));
                        setClearing(flag);
                      }}
                    >
                      {clearLabel(flag)}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorLine message={error} />

      <Dialog
        open={clearing !== null}
        onOpenChange={(open) => !open && setClearing(null)}
        title={`${clearingAction}?`}
        description={
          `Tanda "${clearingLabel}" dihapus dari pesanan ini. Tanda lain tetap ada.`
        }
        confirmLabel={clearingAction}
        cancelLabel="Kembali"
        onConfirm={() => clearing && clear(clearing)}
        loading={pending}
      />

      <Dialog
        open={refunding !== null}
        onOpenChange={(open) => !open && setRefunding(null)}
        title="Catat dana dikembalikan"
        description={refunding ? `Dana ${formatRupiah(refunding.amount)} sudah dikembalikan penuh ke pembeli (transfer bank, atau refund di dashboard Midtrans).` : undefined}
        confirmLabel="Simpan"
        cancelLabel="Kembali"
        onConfirm={() => refunding && refund(refunding)}
        loading={pending}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={noteId}>Catatan</Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Contoh: transfer BCA 21/10 ke rekening pembeli"
            error={noteError ?? undefined}
          />
        </div>
      </Dialog>
    </section>
  );
}

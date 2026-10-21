"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardList, Checkbox, Dialog, EmptyState, TableContainer, TableHead, Th, Tr, Td } from "@ammari/ui";
import { formatDate, formatShortDate } from "@ammari/ui/lib";
import type { PackingPickListItem, PackingQueueRow } from "@/lib/packing/queries";
import {
  bulkMarkShippedAction,
  getCardPrintStatusAction,
  printStickerSheetsAction,
  printThankYouCardsAction,
  type PrintableCard,
} from "../actions";
import { PickList } from "./pick-list";
import { MarkShippedDialog } from "./mark-shipped-dialog";
import { PrintCardsOverlay } from "./print-cards-overlay";

export interface PackingListProps {
  rows: PackingQueueRow[];
  items: Record<string, PackingPickListItem[]>;
  canShip: boolean;
}

type ReprintWarning = { orderIds: string[]; orderNos: string[]; mode: "card" | "sticker" } | null;
type NoCardWarning = { orderIds: string[]; orderNos: string[] } | null;

function CardStatusBadge({ printedAt, claimedAt, isCheckout }: { printedAt: Date | null; claimedAt: Date | null; isCheckout: boolean }) {
  // Web checkout orders never get a thank-you card (SPEC §4.1, docs/plans/cart-checkout.md §7).
  if (isCheckout) {
    return (
      <Badge variant="neutral" className="whitespace-nowrap">
        Tanpa kartu
      </Badge>
    );
  }
  if (claimedAt) {
    return (
      <Badge variant="success" className="whitespace-nowrap">
        Diklaim · {formatShortDate(claimedAt)}
      </Badge>
    );
  }
  return printedAt ? (
    <Badge variant="success" className="whitespace-nowrap">
      Tercetak · {formatShortDate(printedAt)}
    </Badge>
  ) : (
    <Badge variant="neutral">Belum</Badge>
  );
}

/** The courier service a web checkout order was quoted with: staff book exactly this one (before
 * Phase K, by hand). */
function ServiceLine({ label }: { label: string | null }) {
  if (!label) return null;
  return <span className="text-sm text-neutral-700">Kirim: {label}</span>;
}

/** `srLabel`: only needed in the mobile `CardList`, where this renders as a bare string with no
 * surrounding context — the desktop `TableContainer` already gives it one via its own `<Th>Kode
 * stiker</Th>` column header, so that call site omits it. */
function StickerCode({ code, isPreview, srLabel }: { code: string | null; isPreview: boolean; srLabel?: string }) {
  const label = srLabel && <span className="sr-only">{srLabel}: </span>;
  if (!code) {
    return (
      <span className="text-sm text-neutral-500">
        {label}-
      </span>
    );
  }
  return (
    <span className={`whitespace-nowrap font-mono text-sm ${isPreview ? "text-neutral-500 italic" : "font-medium text-neutral-900"}`}>
      {label}
      {code}
      {isPreview && <span className="not-italic"> (pratinjau)</span>}
    </span>
  );
}

/** iPadOS Safari reports its UA as a plain Mac ("Macintosh") since iPadOS 13 — the only reliable
 * way to tell it apart from a real Mac is that a touch-capable Mac UA is always an iPad (no
 * production Mac has a touchscreen). Needed because a synthetic `<a download>` click is
 * unreliable there for blob PDFs across iPadOS versions; opening the blob URL in a new tab
 * instead hands the PDF to Safari's own inline viewer, from which "Cetak"/"Simpan ke File" both
 * work via the share sheet — a better outcome there than a download that may silently do
 * nothing. */
function isLikelyIPadSafari(): boolean {
  return typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/** On the iPad-Safari path, MUST be called synchronously inside the click handler that starts
 * the print — never after an `await` (the two server-action round-trips a real print goes
 * through). Safari only allows `window.open` to create a real, non-blocked window within an
 * actual user-gesture call stack; calling it once the PDF bytes are finally ready (well outside
 * that window) is the textbook case Safari's popup blocker exists to catch, and it fails
 * silently — `window.open` just returns `null`/an already-closed window, with nothing to show
 * for it even though the mint already committed server-side. Opening a blank tab immediately and
 * navigating it later (`popup.location.href = ...`) sidesteps this: the OPEN itself happens in
 * the gesture, only the navigation is deferred. Returns `null` on every other browser, where the
 * plain `<a download>` path below is used instead and no popup is needed at all. */
function openStickerPopupPlaceholder(): Window | null {
  return isLikelyIPadSafari() ? window.open("", "_blank") : null;
}

/** `popup`: whatever `openStickerPopupPlaceholder` returned for THIS SAME click, or `null` on a
 * non-iPad-Safari browser. Returns an error message to show the staffer, or `null` on success. */
function downloadOrOpenPdf(pdfBase64: string, filename: string, popup: Window | null): string | null {
  const binary = atob(pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  if (isLikelyIPadSafari()) {
    if (!popup || popup.closed) {
      URL.revokeObjectURL(url);
      return "Pop-up diblokir. Izinkan pop-up untuk situs ini di pengaturan Safari, lalu coba lagi.";
    }
    popup.location.href = url;
  } else {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
  // Delayed, not immediate — revoking right after `.click()`/navigating `popup` can race the
  // browser actually starting to read the blob in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

export function PackingList({ rows, items, canShip }: PackingListProps) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [shippingOrder, setShippingOrder] = useState<PackingQueueRow | null>(null);
  const [reprintWarning, setReprintWarning] = useState<ReprintWarning>(null);
  const [noCardWarning, setNoCardWarning] = useState<NoCardWarning>(null);
  const [printableCards, setPrintableCards] = useState<PrintableCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A row leaves `rows` the instant its order is shipped (no longer `to_ship`) — after a
  // per-order "Tandai dikirim" (which only ever refreshes the page, never touching
  // `selectedIds` itself), that order's id would otherwise linger in `selectedIds` forever,
  // silently riding along into the NEXT "Cetak kartu"/bulk-ship click as a stale, no-longer-
  // visible id. Derived at render time (never stored as its own state + effect, which would
  // just cause an extra cascading render for the same result) — every action below reads
  // `visibleSelectedIds`, never `selectedIds` directly.
  const visibleSelectedIds = useMemo(() => {
    const visibleIds = new Set(rows.map((row) => row.id));
    return [...selectedIds].filter((id) => visibleIds.has(id));
  }, [selectedIds, rows]);
  // Cards and stickers are printed only for the selected orders that take a card (web checkout
  // orders never do; the server refuses them too). Shipping uses the whole selection.
  const printableSelectedIds = useMemo(() => {
    const checkoutIds = new Set(rows.filter((row) => row.isCheckout).map((row) => row.id));
    return visibleSelectedIds.filter((id) => !checkoutIds.has(id));
  }, [visibleSelectedIds, rows]);
  // Bulk "Tandai dikirim" has no resi field, so it ships only the selected manual and marketplace
  // orders: a web checkout order needs its own courier and resi (2026-10-21 sandbox run; the
  // server refuses it in bulk too). Same split as printing.
  const bulkShippableIds = printableSelectedIds;

  function toggleSelected(orderId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  // Desktop table only — the mobile CardList has no bulk "select all" affordance (each row's
  // own checkbox is already one tap away).
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));
  const someSelected = rows.some((row) => selectedIds.has(row.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const row of rows) {
        if (allSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  function orderNoFor(orderId: string): string {
    return rows.find((r) => r.id === orderId)?.orderNo ?? orderId;
  }

  async function mintAndShowCards(orderIds: string[]) {
    const result = await printThankYouCardsAction(orderIds);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPrintableCards(result.data);
    router.refresh(); // so the card-status badges reflect the fresh print immediately
  }

  // `popup`: already-opened (by the CALLER, synchronously, before any await — see
  // `openStickerPopupPlaceholder`'s own doc comment) on iPad Safari; `null` everywhere else.
  async function mintAndDownloadStickers(orderIds: string[], popup: Window | null) {
    const result = await printStickerSheetsAction(orderIds);
    if (!result.ok) {
      popup?.close();
      setError(result.error);
      return;
    }
    const downloadError = downloadOrOpenPdf(result.data.pdfBase64, result.data.filename, popup);
    if (downloadError) {
      setError(downloadError);
      return;
    }
    router.refresh(); // so the sticker-code/card-status cells reflect the fresh print immediately
  }

  // Shared by both "Cetak stiker" (primary) and "Cetak kartu" (secondary) — printing stickers
  // counts as printing the card (docs/plans/thermal-stickers.md), so both go through the exact
  // same already-printed check and reprint-warning flow, only the mint confirmation's eventual
  // action (`onMint`) differs. `stickerPopup`: already opened synchronously by THIS click (iPad
  // Safari only — see `openStickerPopupPlaceholder`); closed here if the flow turns out to need
  // the reprint-warning dialog instead of minting right away, since a fresh one gets opened by
  // the dialog's own confirm click once the staffer actually proceeds.
  function handlePrintClick(mode: "card" | "sticker", onMint: (orderIds: string[]) => Promise<void>, stickerPopup: Window | null = null) {
    if (printableSelectedIds.length === 0) {
      stickerPopup?.close();
      return;
    }
    setError(null);
    const orderIds = printableSelectedIds;
    startTransition(async () => {
      const statusResult = await getCardPrintStatusAction(orderIds);
      if (!statusResult.ok) {
        stickerPopup?.close();
        setError(statusResult.error);
        return;
      }
      const alreadyPrinted = orderIds.filter((id) => statusResult.data[id]);
      if (alreadyPrinted.length > 0) {
        stickerPopup?.close();
        setReprintWarning({ orderIds, orderNos: alreadyPrinted.map(orderNoFor), mode });
        return;
      }
      await onMint(orderIds);
    });
  }

  function handleBulkShipClick() {
    if (bulkShippableIds.length === 0) return;
    setError(null);
    const orderIds = bulkShippableIds;
    startTransition(async () => {
      const statusResult = await getCardPrintStatusAction(orderIds);
      if (!statusResult.ok) {
        setError(statusResult.error);
        return;
      }
      const missingCard = orderIds.filter((id) => !statusResult.data[id]);
      if (missingCard.length > 0) {
        setNoCardWarning({ orderIds, orderNos: missingCard.map(orderNoFor) });
        return;
      }
      await bulkShip(orderIds, false);
    });
  }

  async function bulkShip(orderIds: string[], confirmNoCard: boolean) {
    const result = await bulkMarkShippedAction({ orderIds, confirmNoCard });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSelectedIds(new Set());
    router.refresh();
  }

  if (rows.length === 0) {
    return <EmptyState title="Antrean packing kosong" description="Belum ada pesanan dengan status Siap Kirim." />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 py-1">
        {/* Primary print path (docs/plans/thermal-stickers.md) — the thermal QR sticker sheet
            replaces the A6/A4 card as the default; the card stays available as a secondary
            option below. Both share the exact same mint/reprint-warning flow. */}
        <Button
          loading={pending}
          disabled={printableSelectedIds.length === 0}
          onClick={() => {
            // Opened HERE, synchronously, inside the real click — not inside the async
            // `mintAndDownloadStickers` this hands off to, which only runs after two awaited
            // server round-trips (well outside Safari's user-gesture window for `window.open`).
            const popup = openStickerPopupPlaceholder();
            handlePrintClick("sticker", (orderIds) => mintAndDownloadStickers(orderIds, popup), popup);
          }}
        >
          {printableSelectedIds.length > 0 ? `Cetak stiker (${printableSelectedIds.length})` : "Cetak stiker"}
        </Button>
        <Button
          variant="secondary"
          loading={pending}
          disabled={printableSelectedIds.length === 0}
          onClick={() => handlePrintClick("card", mintAndShowCards)}
        >
          {printableSelectedIds.length > 0 ? `Cetak kartu (${printableSelectedIds.length})` : "Cetak kartu"}
        </Button>
        {canShip && (
          <Button variant="secondary" loading={pending} disabled={bulkShippableIds.length === 0} onClick={handleBulkShipClick}>
            {bulkShippableIds.length > 0 ? `Tandai dikirim (${bulkShippableIds.length})` : "Tandai dikirim"}
          </Button>
        )}
      </div>
      {printableSelectedIds.length < visibleSelectedIds.length && (
        <p className="text-sm text-neutral-600">
          Pesanan website tidak memakai kartu terima kasih, jadi tidak ikut dicetak. Pesanan website juga perlu nomor resi: tandai dikirim satu per
          satu lewat tombol di barisnya.
        </p>
      )}
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Card className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <Checkbox
                  label={`${row.orderNo} · ${row.channelName}`}
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleSelected(row.id)}
                />
                <CardStatusBadge printedAt={row.cardPrintedAt} claimedAt={row.cardClaimedAt} isCheckout={row.isCheckout} />
              </div>
              <p className="text-sm text-neutral-600">
                {formatDate(new Date(row.orderDate))} · {row.customerName ?? row.buyerUsername ?? "-"}
              </p>
              <ServiceLine label={row.shippingServiceLabel} />
              <StickerCode code={row.stickerCode} isPreview={row.stickerCodeIsPreview} srLabel="Kode stiker" />
              <PickList items={items[row.id] ?? []} />
              {canShip && (
                // Disabled while ANY bulk/print transition is in flight (`pending` covers the
                // header's "Cetak kartu"/"Tandai dikirim" actions) — otherwise a staffer could
                // open this row's own ship dialog for an order the bulk action is concurrently
                // transitioning, firing two independent transitionOrderStatus calls for the
                // same order at once.
                <Button variant="secondary" disabled={pending} onClick={() => setShippingOrder(row)}>
                  Tandai dikirim
                </Button>
              )}
            </Card>
          </li>
        ))}
      </CardList>

      {/* `CardList` is mobile-only (`md:hidden` — see packages/ui/src/components/Table.tsx) with
          no desktop counterpart on its own; without this `TableContainer`, the whole queue
          vanished on any tablet/desktop-width browser even though the server returned rows —
          the exact "server log shows rowCount: 2 but the screen is empty" bug. Every other list
          page (orders, products, stock) pairs `CardList` with `TableContainer` for this reason. */}
      <TableContainer>
        <TableHead>
          <Th className="w-12">
            <Checkbox
              ref={selectAllRef}
              label="Pilih semua"
              hideLabel
              checked={allSelected}
              onChange={toggleSelectAll}
            />
          </Th>
          <Th>No. Pesanan</Th>
          <Th>Tanggal · Pembeli</Th>
          <Th>Kode stiker</Th>
          <Th>Pick list</Th>
          <Th>Kartu</Th>
          {canShip && (
            <Th>
              <span className="sr-only">Aksi</span>
            </Th>
          )}
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td className="w-12">
                <Checkbox
                  label={`Pilih ${row.orderNo}`}
                  hideLabel
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleSelected(row.id)}
                />
              </Td>
              <Td className="whitespace-nowrap text-neutral-700">
                <div className="flex flex-col items-start gap-1">
                  <span className="font-medium">{row.orderNo}</span>
                  <Badge variant="neutral">{row.channelName}</Badge>
                  <ServiceLine label={row.shippingServiceLabel} />
                </div>
              </Td>
              <Td className="text-neutral-700">
                <div className="flex flex-col gap-0.5">
                  <span className="whitespace-nowrap">{formatDate(new Date(row.orderDate))}</span>
                  <span className="max-w-60 truncate text-sm text-neutral-600">
                    {row.customerName ?? row.buyerUsername ?? "-"}
                  </span>
                </div>
              </Td>
              <Td className="whitespace-nowrap">
                <StickerCode code={row.stickerCode} isPreview={row.stickerCodeIsPreview} />
              </Td>
              {/* Capped so `PickList`'s own `truncate` (on each item's product-name line) actually
                  has a width to truncate against — a table cell's content otherwise reports its
                  full intrinsic width to the table layout algorithm, which pushed the Kartu/Aksi
                  columns off the right edge of a 1280px viewport entirely. */}
              <Td className="max-w-64">
                <PickList items={items[row.id] ?? []} />
              </Td>
              <Td>
                <CardStatusBadge printedAt={row.cardPrintedAt} claimedAt={row.cardClaimedAt} isCheckout={row.isCheckout} />
              </Td>
              {canShip && (
                <Td className="whitespace-nowrap">
                  <Button variant="secondary" disabled={pending} onClick={() => setShippingOrder(row)}>
                    Tandai dikirim
                  </Button>
                </Td>
              )}
            </Tr>
          ))}
        </tbody>
      </TableContainer>

      {shippingOrder && (
        <MarkShippedDialog
          key={shippingOrder.id}
          orderId={shippingOrder.id}
          orderNo={shippingOrder.orderNo}
          hasActiveCard={shippingOrder.isCheckout || shippingOrder.cardPrintedAt !== null}
          isCheckout={shippingOrder.isCheckout}
          defaultCourier={shippingOrder.shippingServiceLabel}
          open={shippingOrder !== null}
          onOpenChange={(open) => !open && setShippingOrder(null)}
          onShipped={() => router.refresh()}
        />
      )}

      <Dialog
        open={reprintWarning !== null}
        onOpenChange={(open) => !open && setReprintWarning(null)}
        title="Sudah ada kartu tercetak"
        description={`${reprintWarning?.orderNos.join(", ")} sudah punya kartu terima kasih. Melanjutkan akan membatalkan kode lama dan membuat kode baru.`}
        confirmLabel="Cetak ulang"
        confirmVariant="danger"
        loading={pending}
        onConfirm={() => {
          const orderIds = reprintWarning?.orderIds ?? [];
          const mode = reprintWarning?.mode ?? "card";
          // Synchronously, inside this real confirm click — same reasoning as the toolbar
          // button's own click handler above (`openStickerPopupPlaceholder`'s doc comment).
          const popup = mode === "sticker" ? openStickerPopupPlaceholder() : null;
          setReprintWarning(null);
          startTransition(() => (mode === "sticker" ? mintAndDownloadStickers(orderIds, popup) : mintAndShowCards(orderIds)));
        }}
      />

      <Dialog
        open={noCardWarning !== null}
        onOpenChange={(open) => !open && setNoCardWarning(null)}
        title="Belum ada kartu terima kasih"
        description={`${noCardWarning?.orderNos.join(", ")} belum punya kartu terima kasih. Lanjutkan hanya jika memang tidak perlu kartu.`}
        confirmLabel="Tandai dikirim"
        confirmVariant="danger"
        loading={pending}
        onConfirm={() => {
          const orderIds = noCardWarning?.orderIds ?? [];
          setNoCardWarning(null);
          startTransition(() => bulkShip(orderIds, true));
        }}
      />

      {printableCards && <PrintCardsOverlay cards={printableCards} onClose={() => setPrintableCards(null)} />}
    </>
  );
}

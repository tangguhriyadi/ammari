"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardList, Checkbox, Dialog, EmptyState, TableContainer, TableHead, Th, Tr, Td } from "@ammari/ui";
import { formatDate, formatShortDate } from "@ammari/ui/lib";
import type { PackingPickListItem, PackingQueueRow } from "@/lib/packing/queries";
import { bulkMarkShippedAction, getCardPrintStatusAction, printThankYouCardsAction, type PrintableCard } from "../actions";
import { PickList } from "./pick-list";
import { MarkShippedDialog } from "./mark-shipped-dialog";
import { PrintCardsOverlay } from "./print-cards-overlay";

export interface PackingListProps {
  rows: PackingQueueRow[];
  items: Record<string, PackingPickListItem[]>;
  canShip: boolean;
}

type ReprintWarning = { orderIds: string[]; orderNos: string[] } | null;
type NoCardWarning = { orderIds: string[]; orderNos: string[] } | null;

function CardStatusBadge({ printedAt }: { printedAt: Date | null }) {
  return printedAt ? (
    <Badge variant="success" className="whitespace-nowrap">
      Tercetak · {formatShortDate(printedAt)}
    </Badge>
  ) : (
    <Badge variant="neutral">Belum</Badge>
  );
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

  function handlePrintClick() {
    if (visibleSelectedIds.length === 0) return;
    setError(null);
    const orderIds = visibleSelectedIds;
    startTransition(async () => {
      const statusResult = await getCardPrintStatusAction(orderIds);
      if (!statusResult.ok) {
        setError(statusResult.error);
        return;
      }
      const alreadyPrinted = orderIds.filter((id) => statusResult.data[id]);
      if (alreadyPrinted.length > 0) {
        setReprintWarning({ orderIds, orderNos: alreadyPrinted.map(orderNoFor) });
        return;
      }
      await mintAndShowCards(orderIds);
    });
  }

  function handleBulkShipClick() {
    if (visibleSelectedIds.length === 0) return;
    setError(null);
    const orderIds = visibleSelectedIds;
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
        <Button variant="secondary" loading={pending} disabled={visibleSelectedIds.length === 0} onClick={handlePrintClick}>
          {visibleSelectedIds.length > 0 ? `Cetak kartu (${visibleSelectedIds.length})` : "Cetak kartu"}
        </Button>
        {canShip && (
          <Button variant="secondary" loading={pending} disabled={visibleSelectedIds.length === 0} onClick={handleBulkShipClick}>
            {visibleSelectedIds.length > 0 ? `Tandai dikirim (${visibleSelectedIds.length})` : "Tandai dikirim"}
          </Button>
        )}
      </div>
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
                <CardStatusBadge printedAt={row.cardPrintedAt} />
              </div>
              <p className="text-sm text-neutral-600">
                {formatDate(new Date(row.orderDate))} · {row.customerName ?? row.buyerUsername ?? "—"}
              </p>
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
                </div>
              </Td>
              <Td className="text-neutral-700">
                <div className="flex flex-col gap-0.5">
                  <span className="whitespace-nowrap">{formatDate(new Date(row.orderDate))}</span>
                  <span className="max-w-60 truncate text-sm text-neutral-600">
                    {row.customerName ?? row.buyerUsername ?? "—"}
                  </span>
                </div>
              </Td>
              {/* Capped so `PickList`'s own `truncate` (on each item's product-name line) actually
                  has a width to truncate against — a table cell's content otherwise reports its
                  full intrinsic width to the table layout algorithm, which pushed the Kartu/Aksi
                  columns off the right edge of a 1280px viewport entirely. */}
              <Td className="max-w-64">
                <PickList items={items[row.id] ?? []} />
              </Td>
              <Td>
                <CardStatusBadge printedAt={row.cardPrintedAt} />
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
          orderId={shippingOrder.id}
          orderNo={shippingOrder.orderNo}
          hasActiveCard={shippingOrder.cardPrintedAt !== null}
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
          setReprintWarning(null);
          startTransition(() => mintAndShowCards(orderIds));
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

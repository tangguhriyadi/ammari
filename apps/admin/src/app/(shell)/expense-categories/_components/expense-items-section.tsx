"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, CardList, Dialog, Input, Label, TableContainer, TableHead, Td, Textarea, Th, Tr, useToast } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { ExpenseItemListRow } from "@/lib/expense-categories/queries";
import { createExpenseItemAction, setExpenseItemActiveAction, updateExpenseItemAction } from "../actions";
import { expenseUsageText } from "./usage";

// "Item biaya" of one category (plan §3.6): list in both layouts, add/edit in one dialog,
// Nonaktifkan/Aktifkan per item. Nothing is ever deleted.

type DialogState = { mode: "create" } | { mode: "edit"; item: ExpenseItemListRow } | null;

const ITEM_FIELDS = ["name", "note", "defaultAmount", "sortOrder"] as const;

function ItemDialog({ categoryCode, state, onClose }: { categoryCode: string; state: Exclude<DialogState, null>; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const initial = state.mode === "edit" ? state.item : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [defaultAmount, setDefaultAmount] = useState(initial?.defaultAmount ? formatNumber(initial.defaultAmount) : "");
  const [sortOrder, setSortOrder] = useState(initial ? String(initial.sortOrder) : "0");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function submit() {
    if (pending) return;
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const input = { name, note, defaultAmount, sortOrder: sortOrder.trim() === "" ? 0 : sortOrder };
      const result = state.mode === "edit" ? await updateExpenseItemAction(state.item.id, input) : await createExpenseItemAction(categoryCode, input);
      if (!result.ok) {
        const shown: readonly string[] = ITEM_FIELDS;
        if (result.fieldErrors && Object.keys(result.fieldErrors).every((key) => shown.includes(key))) setFieldErrors(result.fieldErrors);
        else setError(result.error);
        return;
      }
      toast.success(state.mode === "edit" ? "Item biaya disimpan" : `Item ${name.trim()} ditambahkan`);
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      title={state.mode === "edit" ? `Ubah item ${state.item.name}` : "Tambah item biaya"}
      confirmLabel="Simpan item"
      onConfirm={submit}
      loading={pending}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-item-name" required>
            Nama item
          </Label>
          <Input
            id="expense-item-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="mis. Biteship Grow"
            maxLength={80}
            aria-required="true"
            error={fieldErrors.name}
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-item-default-amount">Jumlah default (opsional)</Label>
          <Input
            id="expense-item-default-amount"
            inputMode="numeric"
            value={defaultAmount}
            onChange={(event) => setDefaultAmount(event.target.value)}
            placeholder="mis. 149.000"
            aria-describedby="expense-item-default-amount-hint"
            error={fieldErrors.defaultAmount}
            disabled={pending}
          />
          <p id="expense-item-default-amount-hint" className="text-sm text-neutral-600">
            Mengisi Jumlah otomatis saat mencatat biaya, tetap bisa diubah.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-item-note">Catatan (opsional)</Label>
          <Textarea
            id="expense-item-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={200}
            rows={2}
            error={fieldErrors.note}
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-item-sort-order">Urutan tampil</Label>
          <Input
            id="expense-item-sort-order"
            inputMode="numeric"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            error={fieldErrors.sortOrder}
            disabled={pending}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        )}
        {/* Enter in a field submits through the form; the visible button is the dialog's own. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function amountText(item: ExpenseItemListRow): string {
  return item.defaultAmount === null ? "Tanpa jumlah default" : formatRupiah(item.defaultAmount);
}

export function ExpenseItemsSection({ categoryCode, items }: { categoryCode: string; items: ExpenseItemListRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggle(item: ExpenseItemListRow) {
    if (pendingId !== null) return;
    setError(null);
    setPendingId(item.id);
    startTransition(async () => {
      try {
        const result = await setExpenseItemActiveAction({ id: item.id, isActive: !item.isActive });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        toast.success(item.isActive ? `Item ${item.name} dinonaktifkan` : `Item ${item.name} diaktifkan`);
        router.refresh();
      } finally {
        setPendingId(null);
      }
    });
  }

  // Render helpers, not nested components (a nested component would remount every render).
  function actions(item: ExpenseItemListRow) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => setDialog({ mode: "edit", item })} disabled={pendingId !== null} aria-label={`Ubah ${item.name}`}>
          Ubah
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => toggle(item)}
          loading={pendingId === item.id}
          disabled={pendingId !== null && pendingId !== item.id}
          aria-label={`${item.isActive ? "Nonaktifkan" : "Aktifkan"} ${item.name}`}
        >
          {item.isActive ? "Nonaktifkan" : "Aktifkan"}
        </Button>
      </div>
    );
  }

  function status(item: ExpenseItemListRow) {
    return item.isActive ? <Badge variant="success">Aktif</Badge> : <Badge variant="neutral">Nonaktif</Badge>;
  }

  return (
    <section aria-labelledby="expense-items-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="expense-items-heading" className="text-lg font-semibold text-neutral-900">
            Item biaya
          </h2>
          <p className="text-sm text-neutral-600">Dipilih saat mencatat biaya di kategori ini. Item yang dinonaktifkan tetap tampil di biaya lama.</p>
        </div>
        <Button type="button" onClick={() => setDialog({ mode: "create" })}>
          Tambah item
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-base text-neutral-600">Belum ada item. Tanpa item, biaya di kategori ini dicatat tanpa memilih item.</p>
      ) : (
        <>
          <CardList>
            {items.map((item) => (
              <li key={item.id} data-testid="expense-item-card">
                <Card className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-base font-medium text-neutral-900">{item.name}</p>
                    {status(item)}
                  </div>
                  <p className="text-sm text-neutral-600">
                    {amountText(item)} · {expenseUsageText(item.expenseCount)} · Urutan {item.sortOrder}
                  </p>
                  {item.note && <p className="text-sm text-neutral-700">{item.note}</p>}
                  {actions(item)}
                </Card>
              </li>
            ))}
          </CardList>

          <TableContainer>
            <TableHead>
              <Th>Nama</Th>
              <Th>Jumlah default</Th>
              <Th>Catatan</Th>
              <Th>Dipakai</Th>
              <Th>Urutan</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Aksi</span>
              </Th>
            </TableHead>
            <tbody>
              {items.map((item) => (
                <Tr key={item.id} data-testid="expense-item-row">
                  <Td className="font-medium text-neutral-900">{item.name}</Td>
                  <Td className="text-neutral-700 tabular-nums">{item.defaultAmount === null ? "-" : formatRupiah(item.defaultAmount)}</Td>
                  <Td className="text-neutral-700">{item.note ?? "-"}</Td>
                  <Td className="text-neutral-700">{expenseUsageText(item.expenseCount)}</Td>
                  <Td className="text-neutral-700 tabular-nums">{item.sortOrder}</Td>
                  <Td>{status(item)}</Td>
                  <Td>{actions(item)}</Td>
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}

      {dialog && <ItemDialog key={dialog.mode === "edit" ? dialog.item.id : "create"} categoryCode={categoryCode} state={dialog} onClose={() => setDialog(null)} />}
    </section>
  );
}

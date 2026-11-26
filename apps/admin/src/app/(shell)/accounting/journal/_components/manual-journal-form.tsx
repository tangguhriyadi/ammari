"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { parseRupiah } from "@/lib/products/money";
import { PRIVATE_UPLOAD_ACCEPT } from "@/lib/supplier-payments/messages";
import { postManualJournalAction } from "../actions";

// "Catat jurnal manual" (docs/plans/accounting.md §5, Session 4): date, description, two or more
// lines (account, debit OR credit, memo), an optional attachment, and prefills for the recurring
// entries (top-up Biteship, penarikan saldo, koreksi refund lewat Midtrans...). The totals are shown
// live; the server validates everything again (lib/accounting/manual-journal-input.ts).

export interface AccountChoice {
  code: string;
  name: string;
}

export interface ResolvedTemplate {
  key: string;
  label: string;
  description: string;
  hint: string;
  lines: { accountCode: string; side: "debit" | "credit" }[];
}

interface LineState {
  id: number;
  accountCode: string;
  debit: string;
  credit: string;
  memo: string;
}

const blankLine = (id: number, accountCode = ""): LineState => ({ id, accountCode, debit: "", credit: "", memo: "" });

function amountOf(raw: string): number {
  return raw.trim() === "" ? 0 : (parseRupiah(raw) ?? 0);
}

export function ManualJournalForm({ accounts, templates, defaultDate }: { accounts: AccountChoice[]; templates: ResolvedTemplate[]; defaultDate: string }) {
  const router = useRouter();
  const toast = useToast();
  const formId = useId();
  const [entryDate, setEntryDate] = useState(defaultDate);
  const [description, setDescription] = useState("");
  // Deterministic ids (0, 1, ...) so the server render and hydration agree; keys only.
  const nextId = useRef(2);
  // Ids are taken outside any state updater (an updater may run twice in StrictMode).
  const takeIds = (count: number) => Array.from({ length: count }, () => nextId.current++);
  const [lines, setLines] = useState<LineState[]>(() => [blankLine(0), blankLine(1)]);
  const [templateHint, setTemplateHint] = useState<string | null>(null);
  // A template replaces the lines and the description: confirmed first when something was typed.
  const [pendingTemplate, setPendingTemplate] = useState<ResolvedTemplate | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  const debitTotal = lines.reduce((total, line) => total + amountOf(line.debit), 0);
  const creditTotal = lines.reduce((total, line) => total + amountOf(line.credit), 0);
  const balanced = debitTotal === creditTotal && debitTotal > 0;

  const pristine = description.trim() === "" && lines.every((line) => line.accountCode === "" && line.debit.trim() === "" && line.credit.trim() === "" && line.memo.trim() === "");

  function applyTemplate(template: ResolvedTemplate) {
    const ids = takeIds(template.lines.length);
    setDescription(template.description);
    setTemplateHint(template.hint);
    setLines(template.lines.map((line, index) => blankLine(ids[index]!, line.accountCode)));
    setFieldErrors({});
    setError(null);
    setPendingTemplate(null);
  }

  function chooseTemplate(template: ResolvedTemplate) {
    if (pristine) applyTemplate(template);
    else setPendingTemplate(template);
  }

  function update(id: number, patch: Partial<LineState>) {
    setLines((previous) => previous.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  // Row errors are keyed by position: adding or removing a row clears them, or they would land on
  // the wrong row.
  function addLine() {
    const [id] = takeIds(1);
    setLines((previous) => [...previous, blankLine(id!)]);
    setFieldErrors({});
  }

  function removeLine(id: number) {
    setLines((previous) => previous.filter((item) => item.id !== id));
    setFieldErrors({});
  }

  function handleSubmit() {
    if (saving || done) return;
    setError(null);
    setFieldErrors({});
    const formData = new FormData();
    formData.set("entryDate", entryDate);
    formData.set("description", description);
    formData.set("lines", JSON.stringify(lines.map(({ accountCode, debit, credit, memo }) => ({ accountCode, debit, credit, memo }))));
    if (attachment) formData.set("attachment", attachment);
    startTransition(async () => {
      const result = await postManualJournalAction(formData);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setDone(true);
      toast.success(`Jurnal ${result.data.entryNo} dicatat`);
      router.push("/accounting/journal");
    });
  }

  return (
    <form
      className="flex flex-col gap-5"
      aria-label="Jurnal manual"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      {templates.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Contoh jurnal">
          <p className="text-sm font-medium text-neutral-700">Isi cepat</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((template) => (
              <Button key={template.key} type="button" variant="secondary" onClick={() => chooseTemplate(template)} disabled={saving}>
                {template.label}
              </Button>
            ))}
          </div>
          {templateHint && <p className="text-sm text-neutral-600">{templateHint}</p>}
        </section>
      )}

      <div className="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${formId}-date`} required>
            Tanggal
          </Label>
          <Input id={`${formId}-date`} type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} error={fieldErrors.entryDate} required disabled={saving} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${formId}-description`} required>
            Keterangan
          </Label>
          <Textarea id={`${formId}-description`} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} error={fieldErrors.description} required disabled={saving} />
        </div>
      </div>

      <section className="flex flex-col gap-3" aria-label="Baris jurnal">
        <div className="hidden grid-cols-[minmax(0,2fr)_10rem_10rem_minmax(0,1.5fr)_auto] gap-3 px-1 text-sm font-medium text-neutral-600 md:grid">
          <span>Akun</span>
          <span>Debit (Rp)</span>
          <span>Kredit (Rp)</span>
          <span>Catatan baris</span>
          <span className="sr-only">Hapus</span>
        </div>
        <ol className="flex flex-col gap-3">
          {lines.map((line, index) => {
            const errorOf = (field: string) => fieldErrors[`lines.${index}.${field}`];
            // The server reports an amount problem on ".debit"; show it under the side in use.
            const amountError = errorOf("debit");
            const creditInUse = line.credit.trim() !== "" && line.debit.trim() === "";
            return (
              <li
                key={line.id}
                data-testid="journal-line"
                className="grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 p-3 md:grid-cols-[minmax(0,2fr)_10rem_10rem_minmax(0,1.5fr)_auto] md:items-start md:border-0 md:p-0"
              >
                <div className="col-span-2 flex flex-col gap-1.5 md:col-span-1">
                  <Label htmlFor={`${formId}-account-${index}`} className="md:sr-only">
                    Akun baris {index + 1}
                  </Label>
                  <Select
                    id={`${formId}-account-${index}`}
                    value={line.accountCode}
                    onChange={(event) => update(line.id, { accountCode: event.target.value })}
                    error={errorOf("accountCode")}
                    disabled={saving}
                  >
                    <option value="">Pilih akun</option>
                    {accounts.map((account) => (
                      <option key={account.code} value={account.code}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${formId}-debit-${index}`} className="md:sr-only">
                    Debit baris {index + 1}
                  </Label>
                  <Input
                    id={`${formId}-debit-${index}`}
                    inputMode="numeric"
                    value={line.debit}
                    onChange={(event) => update(line.id, { debit: event.target.value, credit: event.target.value.trim() !== "" ? "" : line.credit })}
                    error={creditInUse ? undefined : amountError}
                    disabled={saving}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${formId}-credit-${index}`} className="md:sr-only">
                    Kredit baris {index + 1}
                  </Label>
                  <Input
                    id={`${formId}-credit-${index}`}
                    inputMode="numeric"
                    value={line.credit}
                    onChange={(event) => update(line.id, { credit: event.target.value, debit: event.target.value.trim() !== "" ? "" : line.debit })}
                    error={creditInUse ? amountError : undefined}
                    disabled={saving}
                  />
                </div>
                <div className="col-span-2 flex flex-col gap-1.5 md:col-span-1">
                  <Label htmlFor={`${formId}-memo-${index}`} className="md:sr-only">
                    Catatan baris {index + 1}
                  </Label>
                  <Input id={`${formId}-memo-${index}`} value={line.memo} onChange={(event) => update(line.id, { memo: event.target.value })} maxLength={500} error={errorOf("memo")} disabled={saving} />
                </div>
                <div className="col-span-2 flex justify-end md:col-span-1">
                  <Button type="button" variant="secondary" onClick={() => removeLine(line.id)} disabled={saving || lines.length <= 2} aria-label={`Hapus baris ${index + 1}`}>
                    Hapus
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={addLine} disabled={saving || lines.length >= 40}>
            Tambah baris
          </Button>
          <p className="text-base tabular-nums" data-testid="journal-totals" aria-live="polite">
            Debit {formatRupiah(debitTotal)} · Kredit {formatRupiah(creditTotal)}{" "}
            <span className={balanced ? "font-medium text-success-700" : "font-medium text-danger-700"}>{balanced ? "Seimbang" : "Belum seimbang"}</span>
          </p>
        </div>
        {fieldErrors.lines && (
          <p role="alert" className="text-sm text-danger-700">
            {fieldErrors.lines}
          </p>
        )}
      </section>

      <div className="flex max-w-xl flex-col gap-1.5">
        <Label htmlFor={`${formId}-attachment`}>Lampiran (opsional)</Label>
        <input
          id={`${formId}-attachment`}
          type="file"
          accept={PRIVATE_UPLOAD_ACCEPT}
          onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
          disabled={saving}
          className="text-base text-neutral-700 file:mr-3 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-3 file:py-2 file:text-base"
        />
        <p className="text-sm text-neutral-600">Foto atau PDF mutasi bank, tangkapan layar dashboard, dan sejenisnya. Maksimal 10 MB.</p>
        {fieldErrors.attachment && (
          <p role="alert" className="text-sm text-danger-700">
            {fieldErrors.attachment}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Dialog
        open={pendingTemplate !== null}
        onOpenChange={(next) => {
          if (!next) setPendingTemplate(null);
        }}
        title={`Pakai isi cepat "${pendingTemplate?.label ?? ""}"?`}
        description="Keterangan dan baris yang sudah diisi akan diganti."
        confirmLabel="Ganti isinya"
        onConfirm={() => pendingTemplate && applyTemplate(pendingTemplate)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving}>
          Simpan jurnal
        </Button>
        <Link href="/accounting/journal" className="text-base font-medium text-brand hover:underline">
          Kembali ke Jurnal Umum
        </Link>
      </div>
    </form>
  );
}

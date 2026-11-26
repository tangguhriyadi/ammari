"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { Button, Card, Checkbox, Input, Label, Select, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { parseRupiah } from "@/lib/products/money";
import { PRIVATE_UPLOAD_ACCEPT } from "@/lib/supplier-payments/messages";
import { postOpeningBalanceAction } from "../actions";

// The opening balance wizard (docs/plans/accounting.md §5.4, D-22, Session 4). Step 1: the system's
// proposals, each checked by the owner (the amount may be corrected; its side stays). Step 2: the
// typed balances (Kas/Bank from bank statements, platform balances from dashboards, anything else).
// The difference goes to Ekuitas saldo awal, shown live. The server recomputes the proposals and
// refuses if they changed since this page was opened.

export interface ProposalView {
  key: string;
  accountCode: string;
  accountName: string;
  label: string;
  basis: string;
  amount: number;
}

export interface TypedAccountView {
  accountCode: string;
  accountName: string;
  hint: string;
}

interface TypedLine {
  id: number;
  accountCode: string;
  debit: string;
  credit: string;
  memo: string;
  hint: string | null;
}

const amountOf = (raw: string) => (raw.trim() === "" ? 0 : (parseRupiah(raw) ?? 0));

export function OpeningBalanceForm({
  proposals,
  typedAccounts,
  accounts,
  equityAccountLabel,
  canPost,
  blockedReason,
}: {
  proposals: ProposalView[];
  typedAccounts: TypedAccountView[];
  accounts: { code: string; name: string }[];
  equityAccountLabel: string;
  canPost: boolean;
  blockedReason: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const formId = useId();
  const [answers, setAnswers] = useState(() => Object.fromEntries(proposals.map((proposal) => [proposal.key, { confirmed: false, amount: String(Math.abs(proposal.amount)) }])));
  const nextId = useRef(typedAccounts.length);
  const [lines, setLines] = useState<TypedLine[]>(() => typedAccounts.map((account, index) => ({ id: index, accountCode: account.accountCode, debit: "", credit: "", memo: "", hint: account.hint })));
  const [attachment, setAttachment] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  let debitTotal = 0;
  let creditTotal = 0;
  for (const proposal of proposals) {
    const amount = amountOf(answers[proposal.key]?.amount ?? "");
    if (proposal.amount > 0) debitTotal += amount;
    else creditTotal += amount;
  }
  for (const line of lines) {
    debitTotal += amountOf(line.debit);
    creditTotal += amountOf(line.credit);
  }
  const plug = creditTotal - debitTotal;
  const allConfirmed = proposals.every((proposal) => answers[proposal.key]?.confirmed);
  // Read-only while nothing can be posted (no permission, too early, already posted) or saving.
  const locked = saving || !canPost;

  function updateLine(id: number, patch: Partial<TypedLine>) {
    setLines((previous) => previous.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function handleSubmit() {
    if (saving || done || !canPost) return;
    setError(null);
    setFieldErrors({});
    const formData = new FormData();
    formData.set(
      "proposals",
      JSON.stringify(proposals.map((proposal) => ({ key: proposal.key, confirmed: answers[proposal.key]?.confirmed ?? false, amount: answers[proposal.key]?.amount ?? "", proposedAmount: proposal.amount }))),
    );
    formData.set("lines", JSON.stringify(lines.map(({ accountCode, debit, credit, memo }) => ({ accountCode, debit, credit, memo }))));
    if (attachment) formData.set("attachment", attachment);
    startTransition(async () => {
      const result = await postOpeningBalanceAction(formData);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setDone(true);
      toast.success(`Saldo awal dibukukan: ${result.data.entryNo}`);
      router.push("/accounting/journal?from=2027-01-01&to=2027-01-31&kind=opening");
    });
  }

  return (
    <form
      className="flex flex-col gap-6"
      aria-label="Saldo awal"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <section className="flex flex-col gap-3" aria-labelledby={`${formId}-proposals`}>
        <h2 id={`${formId}-proposals`} className="text-lg font-semibold text-neutral-900">
          1. Usulan dari data aplikasi
        </h2>
        <p className="text-base text-neutral-600">Periksa setiap baris, betulkan jumlahnya bila perlu, lalu centang.</p>
        {proposals.length === 0 && <p className="text-base text-neutral-600">Tidak ada usulan: belum ada stok, utang atau uang muka per 31 Desember 2026.</p>}
        <ul className="flex flex-col gap-3">
          {proposals.map((proposal) => {
            const answer = answers[proposal.key] ?? { confirmed: false, amount: "" };
            const fieldError = fieldErrors[`proposals.${proposal.key}`];
            return (
              <li key={proposal.key} data-testid="opening-proposal">
                <Card className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_14rem_auto] md:items-center">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-neutral-900">
                      <span className="tabular-nums text-neutral-600">{proposal.accountCode}</span> {proposal.accountName}
                    </span>
                    <span className="text-sm text-neutral-600">{proposal.label}</span>
                    <span className="text-sm text-neutral-600">{proposal.basis}</span>
                    <span className="text-sm text-neutral-600">Usulan: {formatRupiah(Math.abs(proposal.amount))} {proposal.amount > 0 ? "debit" : "kredit"}</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-proposal-${proposal.key}`}>
                      {proposal.amount > 0 ? "Debit (Rp)" : "Kredit (Rp)"}
                      <span className="sr-only">: {proposal.label}</span>
                    </Label>
                    <Input
                      id={`${formId}-proposal-${proposal.key}`}
                      inputMode="numeric"
                      value={answer.amount}
                      onChange={(event) => setAnswers((previous) => ({ ...previous, [proposal.key]: { ...answer, amount: event.target.value } }))}
                      error={fieldError}
                      disabled={locked}
                    />
                  </div>
                  <Checkbox
                    label={
                      <>
                        Sudah dicek<span className="sr-only">: {proposal.label}</span>
                      </>
                    }
                    checked={answer.confirmed}
                    onChange={(event) => setAnswers((previous) => ({ ...previous, [proposal.key]: { ...answer, confirmed: event.target.checked } }))}
                    disabled={locked}
                  />
                </Card>
              </li>
            );
          })}
        </ul>
        {fieldErrors.proposals && (
          <p role="alert" className="text-sm text-danger-700">
            {fieldErrors.proposals}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby={`${formId}-typed`}>
        <h2 id={`${formId}-typed`} className="text-lg font-semibold text-neutral-900">
          2. Saldo yang diisi sendiri
        </h2>
        <p className="text-base text-neutral-600">Kas dan bank dari rekening koran, saldo platform dari dashboard, aset tetap, dan saldo lain per 31 Desember 2026. Kosongkan yang nol.</p>
        <ol className="flex flex-col gap-3">
          {lines.map((line, index) => (
            <li key={line.id} data-testid="opening-typed-line" className="grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 p-3 md:grid-cols-[minmax(0,2fr)_10rem_10rem_minmax(0,1.5fr)] md:items-start">
              <div className="col-span-2 flex flex-col gap-1.5 md:col-span-1">
                <Label htmlFor={`${formId}-typed-account-${index}`}>Akun baris {index + 1}</Label>
                <Select id={`${formId}-typed-account-${index}`} value={line.accountCode} onChange={(event) => updateLine(line.id, { accountCode: event.target.value })} error={fieldErrors[`lines.${index}.accountCode`]} disabled={locked}>
                  <option value="">Pilih akun</option>
                  {accounts.map((account) => (
                    <option key={account.code} value={account.code}>
                      {account.code} {account.name}
                    </option>
                  ))}
                </Select>
                {line.hint && <span className="text-sm text-neutral-600">{line.hint}</span>}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-typed-debit-${index}`}>Debit baris {index + 1} (Rp)</Label>
                <Input id={`${formId}-typed-debit-${index}`} inputMode="numeric" value={line.debit} onChange={(event) => updateLine(line.id, { debit: event.target.value, credit: event.target.value.trim() !== "" ? "" : line.credit })} error={line.credit.trim() !== "" && line.debit.trim() === "" ? undefined : fieldErrors[`lines.${index}.debit`]} disabled={locked} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-typed-credit-${index}`}>Kredit baris {index + 1} (Rp)</Label>
                <Input id={`${formId}-typed-credit-${index}`} inputMode="numeric" value={line.credit} onChange={(event) => updateLine(line.id, { credit: event.target.value, debit: event.target.value.trim() !== "" ? "" : line.debit })} error={line.credit.trim() !== "" && line.debit.trim() === "" ? fieldErrors[`lines.${index}.debit`] : undefined} disabled={locked} />
              </div>
              <div className="col-span-2 flex flex-col gap-1.5 md:col-span-1">
                <Label htmlFor={`${formId}-typed-memo-${index}`}>Catatan baris {index + 1}</Label>
                <Input id={`${formId}-typed-memo-${index}`} value={line.memo} onChange={(event) => updateLine(line.id, { memo: event.target.value })} maxLength={500} error={fieldErrors[`lines.${index}.memo`]} disabled={locked} />
              </div>
            </li>
          ))}
        </ol>
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const id = nextId.current++;
              setLines((previous) => [...previous, { id, accountCode: "", debit: "", credit: "", memo: "", hint: null }]);
            }}
            disabled={saving || lines.length >= 40}
          >
            Tambah baris
          </Button>
        </div>
        {fieldErrors.lines && (
          <p role="alert" className="text-sm text-danger-700">
            {fieldErrors.lines}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-label="Ringkasan saldo awal">
        <p className="text-base tabular-nums" data-testid="opening-summary">
          Debit {formatRupiah(debitTotal)} · Kredit {formatRupiah(creditTotal)}
        </p>
        <p className="text-base text-neutral-900">
          Selisih ke {equityAccountLabel}: {plug === 0 ? "tidak ada" : `${formatRupiah(Math.abs(plug))} ${plug > 0 ? "debit" : "kredit"}`}
        </p>
        <p className="text-sm text-neutral-600">Setelah saldo awal disetujui, pindahkan selisih ini ke Modal pemilik dengan jurnal manual (isi cepat &quot;Tutup ekuitas saldo awal ke modal&quot;).</p>
      </section>

      <div className="flex max-w-xl flex-col gap-1.5">
        <Label htmlFor={`${formId}-attachment`}>Lampiran (opsional)</Label>
        <input
          id={`${formId}-attachment`}
          type="file"
          accept={PRIVATE_UPLOAD_ACCEPT}
          onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
          disabled={locked}
          className="text-base text-neutral-700 file:mr-3 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-3 file:py-2 file:text-base"
        />
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
      {blockedReason && <p className="text-base text-neutral-700">{blockedReason}</p>}
      {!blockedReason && !allConfirmed && <p className="text-base text-neutral-700">Centang semua usulan setelah diperiksa, baru saldo awal bisa dibukukan.</p>}
      <div>
        <Button type="submit" loading={saving} disabled={!canPost || !allConfirmed}>
          Bukukan saldo awal
        </Button>
      </div>
    </form>
  );
}

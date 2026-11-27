import Link from "next/link";
import type { ReactNode } from "react";
import { Button, Input, Label } from "@ammari/ui";
import { formatBalance } from "@/lib/accounting/format";
import { statementBalanced } from "@/lib/accounting/statement-content";
import type { Statement, StatementRow } from "@/lib/accounting/statement-layout";

// One renderer for Neraca, Laba rugi and Arus kas (docs/plans/accounting.md §6, Session 10): the
// same rows the PDF and Excel files get (statement-layout.ts). Phones get a stacked list (each row's
// amounts under its label when there is more than one column), tablet/desktop a table. Every account
// row links to its Buku besar for the statement's own range (drill-down to the journal and source).

const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

const amountText = (value: number | null) => (value === null ? "" : value === 0 ? "-" : formatBalance(value));

const LABEL_STYLE: Record<StatementRow["style"], string> = {
  section: "pt-4 text-sm font-semibold uppercase tracking-wide text-brand",
  group: "font-medium text-neutral-900",
  account: "text-neutral-900",
  subtotal: "font-medium text-neutral-900",
  total: "font-semibold text-neutral-900",
};

function RowLabel({ row, ledgerRange }: { row: StatementRow; ledgerRange: string }) {
  if (!row.accountCode) return <>{row.label}</>;
  return (
    <Link href={`/accounting/ledger?account=${encodeURIComponent(row.accountCode)}${ledgerRange}`} className="hover:underline">
      <span className="tabular-nums text-neutral-600">{row.accountCode}</span> {row.label}
    </Link>
  );
}

export function StatementView({ statement, ledgerRange, label }: { statement: Statement; ledgerRange: string; label: string }) {
  const multi = statement.columns.length > 1;
  return (
    <>
      <ul className="flex flex-col md:hidden" aria-label={label}>
        {statement.rows.map((row) => (
          <li
            key={row.key}
            data-testid="statement-card"
            data-row={row.key}
            className={cn("border-b border-neutral-100 py-2", row.style === "total" && "border-t border-neutral-300", row.style === "section" && "border-b-0")}
            style={{ paddingLeft: `${row.depth * 0.75}rem` }}
          >
            {multi && row.style !== "section" && row.style !== "group" ? (
              <div className="flex flex-col gap-1">
                <span className={LABEL_STYLE[row.style]}>
                  <RowLabel row={row} ledgerRange={ledgerRange} />
                </span>
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 text-base tabular-nums">
                  {statement.columns.map((column, index) => (
                    <div key={column.key} className="contents">
                      <dt className="text-sm text-neutral-600">{column.label}</dt>
                      <dd className="text-right">{amountText(row.amounts[index] ?? null)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <div className="flex items-baseline justify-between gap-3">
                <span className={LABEL_STYLE[row.style]}>
                  <RowLabel row={row} ledgerRange={ledgerRange} />
                </span>
                <span className={cn("whitespace-nowrap text-right tabular-nums", (row.style === "total" || row.style === "subtotal") && "font-medium")}>{amountText(row.amounts[0] ?? null)}</span>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block">
        <table className="w-full text-left text-base" aria-label={label}>
          <thead className="border-b border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Uraian
              </th>
              {statement.columns.map((column) => (
                <th key={column.key} scope="col" className="whitespace-nowrap px-4 py-2 text-right font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {statement.rows.map((row) => (
              <tr
                key={row.key}
                data-testid="statement-row"
                data-row={row.key}
                className={cn("border-b border-neutral-100", row.style === "total" && "border-t border-neutral-300 bg-neutral-50", row.style === "account" && "hover:bg-neutral-50")}
              >
                <th scope="row" className={cn("px-4 py-2 text-left font-normal", LABEL_STYLE[row.style])} style={{ paddingLeft: `${1 + row.depth * 1.25}rem` }}>
                  <RowLabel row={row} ledgerRange={ledgerRange} />
                </th>
                {statement.columns.map((column, index) => (
                  <td key={column.key} className={cn("whitespace-nowrap px-4 py-2 text-right tabular-nums", (row.style === "total" || row.style === "subtotal") && "font-medium")}>
                    {amountText(row.amounts[index] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <StatementChecks statement={statement} />
    </>
  );
}

export function StatementChecks({ statement }: { statement: Statement }) {
  const balanced = statementBalanced(statement);
  return (
    <div className="mt-4 flex flex-col gap-1 text-sm" data-testid="statement-checks">
      <span className={cn("font-medium", balanced ? "text-success-700" : "text-danger-700")}>{balanced ? "Seimbang" : "Tidak seimbang"}</span>
      <ul className="flex flex-col gap-0.5 text-neutral-600">
        {statement.checks.map((check) => (
          <li key={check.label} className={check.ok ? undefined : "text-danger-700"}>
            {check.ok ? "Cocok" : "Tidak cocok"}: {check.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StatementNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-1 text-sm text-neutral-600" data-testid="statement-notes">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

export function ExportButtons({ href }: { href: string }) {
  return (
    <div className="flex flex-wrap gap-3">
      <a href={`${href}&format=pdf`} download>
        <Button variant="secondary">Unduh PDF</Button>
      </a>
      <a href={`${href}&format=xlsx`} download>
        <Button variant="secondary">Unduh Excel</Button>
      </a>
    </div>
  );
}

export function DateField({ id, name, label, value }: { id: string; name: string; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type="date" defaultValue={value} />
    </div>
  );
}

export function FilterForm({ label, children }: { label: string; children: ReactNode }) {
  return (
    <form method="GET" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end lg:max-w-4xl" aria-label={label}>
      {children}
      <div>
        <Button type="submit">Tampilkan</Button>
      </div>
    </form>
  );
}

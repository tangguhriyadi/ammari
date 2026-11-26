import Link from "next/link";
import { Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { formatDay } from "@/lib/accounting/format";
import { TAXPAYER_TYPE_LABELS } from "@/lib/accounting/labels";
import type { TaxSettingRow } from "@/lib/accounting/tax-settings";
import { formatBpsAsPercent } from "@/lib/accounting/tax-settings-input";

// The PPh final settings, newest first (both layouts: CardList < md, TableContainer >= md).

function monthText(month: string): string {
  return formatDay(month).replace(/^1 /, "");
}

function validUntilText(row: TaxSettingRow): string {
  return row.rateValidUntil ? formatDay(row.rateValidUntil) : "Tanpa batas";
}

export function TaxSettingList({ rows, canManage }: { rows: TaxSettingRow[]; canManage: boolean }) {
  if (rows.length === 0) return <EmptyState title="Belum ada pengaturan pajak" description="Tambahkan pengaturan PPh final." />;
  const href = (row: TaxSettingRow) => `/accounting/tax-settings/${row.effectiveFrom}`;

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.effectiveFrom} data-testid="tax-setting-card">
            <Card className="flex flex-col gap-1">
              <p className="text-base font-medium text-neutral-900">Berlaku mulai {monthText(row.effectiveFrom)}</p>
              <p className="text-sm text-neutral-700">
                Tarif {formatBpsAsPercent(row.rateBps)}% · Bebas pajak {formatRupiah(row.annualExemptionAmount)} per tahun
              </p>
              <p className="text-sm text-neutral-700">Tarif berlaku sampai: {validUntilText(row)}</p>
              <p className="text-sm text-neutral-600">
                {TAXPAYER_TYPE_LABELS[row.taxpayerType]}: {row.taxpayerLabel}
                {row.npwpRegisteredYear ? `, NPWP ${row.npwpRegisteredYear}` : ""}
              </p>
              {row.note && <p className="text-sm text-neutral-600">{row.note}</p>}
              {canManage && (
                <Link href={href(row)} className="inline-flex min-h-11 items-center text-base font-medium text-brand hover:underline">
                  Ubah
                </Link>
              )}
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Berlaku mulai</Th>
          <Th>Wajib pajak</Th>
          <Th>Tarif</Th>
          <Th>Bebas pajak per tahun</Th>
          <Th>Tarif berlaku sampai</Th>
          <Th>Catatan</Th>
          {canManage && <Th>Aksi</Th>}
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.effectiveFrom} data-testid="tax-setting-row">
              <Td className="font-medium text-neutral-900">{monthText(row.effectiveFrom)}</Td>
              <Td className="text-neutral-700">
                {TAXPAYER_TYPE_LABELS[row.taxpayerType]}: {row.taxpayerLabel}
                {row.npwpRegisteredYear ? `, NPWP ${row.npwpRegisteredYear}` : ""}
              </Td>
              <Td className="tabular-nums text-neutral-700">{formatBpsAsPercent(row.rateBps)}%</Td>
              <Td className="tabular-nums text-neutral-700">{formatRupiah(row.annualExemptionAmount)}</Td>
              <Td className="text-neutral-700">{validUntilText(row)}</Td>
              <Td className="text-sm text-neutral-600">{row.note ?? ""}</Td>
              {canManage && (
                <Td>
                  <Link href={href(row)} className="font-medium text-brand hover:underline">
                    Ubah
                  </Link>
                </Td>
              )}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

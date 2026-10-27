import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { CustomerListRow } from "@/lib/customers/directory";
import { CUSTOMER_ORIGIN_LABELS } from "@/lib/customers/labels";

// Tab "Pelanggan" (docs/plans/growth.md §8.2): a card per customer on phones, a table on
// tablet/desktop. Contacts arrive already masked from the server (A5); the full ones are only on
// the detail page.

function ConsentBadges({ row }: { row: CustomerListRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant={row.pdpConsentAt ? "success" : "neutral"}>{row.pdpConsentAt ? "PDP" : "PDP belum"}</Badge>
      <Badge variant={row.promoConsentAt ? "success" : "neutral"}>{row.promoConsentAt ? "Promo" : "Promo tidak"}</Badge>
    </div>
  );
}

function Contact({ row }: { row: CustomerListRow }) {
  const parts = [row.maskedPhone, row.maskedEmail].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? (
    <span className="flex flex-col">
      {parts.map((part) => (
        <span key={part} className="tabular-nums">
          {part}
        </span>
      ))}
    </span>
  ) : (
    <span>-</span>
  );
}

export function CustomerList({ rows }: { rows: CustomerListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pelanggan" description="Tidak ada pelanggan yang cocok dengan filter ini." />;
  }
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id} data-testid="customer-card">
            <Card className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/customers/${row.id}`} className="text-base font-medium text-brand hover:underline">
                    {row.name}
                  </Link>
                  <p className="text-sm text-neutral-600">{CUSTOMER_ORIGIN_LABELS[row.origin]}</p>
                </div>
                <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(row.totalSpend)}</span>
              </div>
              <div className="text-sm text-neutral-800">
                <Contact row={row} />
              </div>
              <ConsentBadges row={row} />
              <p className="text-sm text-neutral-600">
                {formatNumber(row.orderCount)} pesanan
                {row.lastOrderAt ? ` · terakhir ${formatDate(row.lastOrderAt)}` : ""} · dibuat {formatDate(row.createdAt)}
              </p>
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Kontak</Th>
          <Th>Asal</Th>
          <Th>Persetujuan</Th>
          <Th>Dibuat</Th>
          <Th>Pesanan terakhir</Th>
          <Th className="text-right">Jumlah pesanan</Th>
          <Th className="text-right">Total belanja</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id} data-testid="customer-row">
              <Td className="font-medium">
                <Link href={`/customers/${row.id}`} className="text-brand hover:underline">
                  {row.name}
                </Link>
              </Td>
              <Td className="text-sm text-neutral-700">
                <Contact row={row} />
              </Td>
              <Td className="text-neutral-700">{CUSTOMER_ORIGIN_LABELS[row.origin]}</Td>
              <Td>
                <ConsentBadges row={row} />
              </Td>
              <Td className="whitespace-nowrap text-neutral-700">{formatDate(row.createdAt)}</Td>
              <Td className="whitespace-nowrap text-neutral-700">{row.lastOrderAt ? formatDate(row.lastOrderAt) : "-"}</Td>
              <Td className="text-right tabular-nums text-neutral-700">{formatNumber(row.orderCount)}</Td>
              <Td className="text-right tabular-nums text-neutral-900">{formatRupiah(row.totalSpend)}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

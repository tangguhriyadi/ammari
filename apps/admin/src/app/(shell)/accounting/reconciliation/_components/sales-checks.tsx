import Link from "next/link";
import { Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatBalance } from "@/lib/accounting/format";
import type { BiteshipCheck, SalesCheck, SalesCheckKind, SalesOrderRow } from "@/lib/accounting/reconciliation";
import { Amount, StatusBadge } from "./status";

// Rekonsiliasi checks 1 (1-1505), 3 (2-1201), 3c (2-1203) and 3b (1-1603) (docs/plans/accounting.md
// §6.3, Session 9). Per order: what the order's records say against the journals carrying its id.

const CHECK_TEXT: Record<SalesCheckKind, { title: string; app: string; description: string }> = {
  sold_not_shipped: {
    title: "Barang terjual belum dikirim",
    app: "Menurut pesanan",
    description: "Harga pokok barang yang sudah keluar dari stok tetapi belum diserahkan ke kurir. Nol setelah pesanan dikirim atau dibatalkan.",
  },
  deposit: {
    title: "Uang muka pelanggan",
    app: "Menurut pembayaran",
    description: "Uang pembeli website dan pesanan manual yang sudah diterima tetapi barangnya belum dikirim dan belum dikembalikan.",
  },
  buyer_shipping: {
    title: "Titipan ongkir pembeli",
    app: "Menurut pesanan",
    description:
      "Ongkir yang dibayar pembeli dikurangi ongkir kurir yang sudah dipotong dari saldo Biteship. Nol setelah pesanan dikirim dan kurirnya dipesan. Pesanan yang dikirim tanpa pemesanan kurir di aplikasi tetap bersisa, bereskan dengan jurnal manual.",
  },
};

function rowNote(row: SalesOrderRow): string | null {
  const notes: string[] = [];
  if (row.pending) notes.push("menunggu data (tanggal kirim marketplace atau cara bayar), lihat posting yang perlu dicek");
  if (row.status === "mismatch" && !row.pending) notes.push("jurnal pesanan ini belum lengkap, lihat posting yang perlu dicek");
  if (row.status === "review") notes.push("sebagian kejadian sebelum pembukuan, cocokkan dengan saldo awal");
  return notes.length > 0 ? notes.join("; ") : null;
}

function OrderLink({ row }: { row: SalesOrderRow }) {
  return (
    <Link href={`/orders/${row.orderId}`} className="font-medium text-neutral-900 hover:underline">
      {row.orderNo}
    </Link>
  );
}

function SalesCheckSection({ check, asOf, segmentStart }: { check: SalesCheck; asOf: string; segmentStart: string }) {
  const text = CHECK_TEXT[check.kind];
  const headingId = `reconciliation-sales-${check.kind}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-testid={`reconciliation-sales-${check.kind}`}>
      <h3 id={headingId} className="text-base font-semibold text-neutral-900">
        <Link href={`/accounting/ledger?account=${check.accountCode}&from=${segmentStart}&to=${asOf}`} className="hover:underline">
          <span className="tabular-nums text-neutral-600">{check.accountCode}</span> {check.accountName}
        </Link>
      </h3>
      <p className="text-sm text-neutral-600">{text.description}</p>
      <Card className="flex flex-col gap-1 text-base">
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Saldo di buku besar</span>
          <Amount value={check.ledgerTotal} />
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Di luar pesanan (jurnal manual, saldo awal)</span>
          <Amount value={check.outsideOrders} />
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Pesanan tidak cocok</span>
          <span className="tabular-nums" data-testid="reconciliation-sales-mismatches">
            {check.mismatchCount}
          </span>
        </div>
      </Card>

      {check.rows.length === 0 ? (
        <EmptyState title="Tidak ada pesanan yang bersaldo" description="Pesanan muncul di sini selama akun ini masih menyimpan saldo untuknya, atau bila ada selisih." />
      ) : (
        <>
          {check.rowCount > check.rows.length && (
            <p className="text-sm text-neutral-600">
              Menampilkan {check.rows.length} dari {check.rowCount} pesanan, yang tidak cocok lebih dulu.
            </p>
          )}
          <CardList>
            {check.rows.map((row) => {
              const note = rowNote(row);
              return (
                <li key={row.orderId} data-testid="reconciliation-sales-card">
                  <Card className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <OrderLink row={row} />
                      <StatusBadge status={row.status} />
                    </div>
                    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-base">
                      <dt className="text-neutral-600">{text.app}</dt>
                      <dd className="text-right">
                        <Amount value={row.app} />
                      </dd>
                      <dt className="text-neutral-600">Saldo jurnal pesanan</dt>
                      <dd className="text-right">
                        <Amount value={row.ledger} />
                      </dd>
                      <dt className="font-medium text-neutral-900">Selisih</dt>
                      <dd className="text-right font-medium">
                        <Amount value={row.difference} />
                      </dd>
                    </dl>
                    {note && <p className="text-sm text-neutral-600">{note}</p>}
                  </Card>
                </li>
              );
            })}
          </CardList>
          <TableContainer>
            <caption className="sr-only">{text.title} per pesanan</caption>
            <TableHead>
              <Th scope="col">Pesanan</Th>
              <Th scope="col" className="text-right">
                {text.app}
              </Th>
              <Th scope="col" className="text-right">
                Saldo jurnal pesanan
              </Th>
              <Th scope="col" className="text-right">
                Selisih
              </Th>
              <Th scope="col">Status</Th>
            </TableHead>
            <tbody>
              {check.rows.map((row) => {
                const note = rowNote(row);
                return (
                  <Tr key={row.orderId} data-testid="reconciliation-sales-row">
                    <Td>
                      <OrderLink row={row} />
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      <Amount value={row.app} />
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      <Amount value={row.ledger} />
                    </Td>
                    <Td className="whitespace-nowrap text-right font-medium">
                      <Amount value={row.difference} />
                    </Td>
                    <Td>
                      <StatusBadge status={row.status} />
                      {note && <span className="mt-1 block max-w-xs text-sm text-neutral-600">{note}</span>}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableContainer>
        </>
      )}
    </section>
  );
}

export function SalesChecks({ checks, asOf, segmentStart }: { checks: SalesCheck[]; asOf: string; segmentStart: string }) {
  return (
    <div className="flex flex-col gap-8">
      {checks.map((check) => (
        <SalesCheckSection key={check.kind} check={check} asOf={asOf} segmentStart={segmentStart} />
      ))}
    </div>
  );
}

export function BiteshipCard({ check, asOf, segmentStart }: { check: BiteshipCheck; asOf: string; segmentStart: string }) {
  return (
    <Card className="flex flex-col gap-3" data-testid="reconciliation-biteship">
      <Link href={`/accounting/ledger?account=${check.accountCode}&from=${segmentStart}&to=${asOf}`} className="hover:underline">
        <span className="tabular-nums text-neutral-600">{check.accountCode}</span> <span className="font-medium text-neutral-900">{check.accountName}</span>
      </Link>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-base">
        <dt className="text-neutral-600">Saldo di buku besar</dt>
        <dd className="text-right">
          <Amount value={check.ledger} />
        </dd>
        <dt className="pl-3 text-sm text-neutral-600">Ongkir pemesanan kurir (otomatis)</dt>
        <dd className="text-right text-sm">
          <Amount value={check.bookings} />
        </dd>
        <dt className="pl-3 text-sm text-neutral-600">Top-up dan jurnal lain</dt>
        <dd className="text-right text-sm">
          <Amount value={check.otherJournals} />
        </dd>
        <dt className="text-neutral-600">Saldo di dashboard Biteship</dt>
        <dd className="text-right">{check.typed === null ? <span className="text-neutral-600">belum diisi</span> : <Amount value={check.typed} />}</dd>
        <dt className="font-medium text-neutral-900">Selisih</dt>
        <dd className="text-right font-medium" data-testid="reconciliation-biteship-difference">
          {check.difference === null ? "-" : formatBalance(check.difference)}
        </dd>
      </dl>
      <p className="text-sm text-neutral-600">
        {check.typed === null
          ? "Isi saldo dari dashboard Biteship per tanggal ini di atas untuk melihat selisihnya."
          : check.difference === 0
            ? "Saldo buku sama dengan dashboard."
            : "Selisih biasanya top-up yang belum dijurnal atau potongan ongkir retur. Bereskan dengan jurnal manual (templat Top-up Biteship)."}
      </p>
    </Card>
  );
}

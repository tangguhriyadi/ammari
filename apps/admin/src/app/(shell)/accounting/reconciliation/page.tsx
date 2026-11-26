import Link from "next/link";
import { Breadcrumb, Button, Card, CardList, EmptyState, Input, Label, PageHeader, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { isCalendarDate, OFFICIAL_BOOKS_START, TRIAL_BOOKS_START } from "@ammari/accounting";
import { requirePermission } from "@/lib/auth/require-permission";
import { formatBalance, formatDay } from "@/lib/accounting/format";
import { getReconciliation, type MaterialRow, type PayableRow, type Reconciliation, type StockAccountRow, type WipBatchRow } from "@/lib/accounting/reconciliation";
import { parseTypedBalance, type ReconciliationStatus } from "@/lib/accounting/reconciliation-rules";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { BiteshipCard, SalesChecks } from "./_components/sales-checks";
import { Amount, StatusBadge } from "./_components/status";

// Rekonsiliasi (docs/plans/accounting.md §6.3, Sessions 7, 8 and 9): check 1 (persediaan bahan, barang
// dalam proses per batch, barang jadi, barang terjual belum dikirim and barang cacat vs the app's
// records), check 2 (utang pemasok per dokumen pembelian vs tagihan di aplikasi), checks 3 and 3c
// (uang muka pelanggan, titipan ongkir pembeli per pesanan) and 3b (saldo Biteship vs the balance
// typed from its dashboard, never stored). accounting.view.
// The "per tanggal" filter and the typed Biteship balance live in the URL (a GET form); every figure
// is summed within the set of books that date belongs to (books.ts).

type RawParams = { date?: string | string[]; biteship?: string | string[] };

function booksNote(report: Reconciliation): string {
  if (report.segment === "official") return `Buku resmi: dihitung sejak ${formatDay(OFFICIAL_BOOKS_START)}, termasuk saldo awal.`;
  if (report.segment === "trial") return `Buku uji coba Desember 2026: dihitung sejak ${formatDay(TRIAL_BOOKS_START)}, tanpa saldo awal.`;
  return `Tanggal ini sebelum pembukuan dimulai (${formatDay(TRIAL_BOOKS_START)}), jadi belum ada jurnal.`;
}

interface InventoryCardData {
  accountCode: string;
  accountName: string;
  ledger: number;
  stockValue: number;
  notJournaled: { label: string; value: number }[];
  difference: number;
  status: ReconciliationStatus;
  stockLabel: string;
}

function materialCardData(row: MaterialRow): InventoryCardData {
  return {
    accountCode: row.accountCode,
    accountName: row.accountName,
    ledger: row.ledger,
    stockValue: row.stockValue,
    notJournaled: [
      { label: "Pembelian cara lama (tanpa dokumen)", value: row.legacy },
      { label: "Pembatalan penerimaan dari sebelum pembukuan", value: row.voidsBeforeBooks },
    ].filter((item) => item.value !== 0),
    difference: row.difference,
    status: row.status,
    stockLabel: "Nilai menurut catatan stok",
  };
}

const STOCK_LABEL: Record<StockAccountRow["kind"], string> = {
  wip: "Sisa biaya batch yang masih berjalan",
  finished: "Nilai menurut catatan stok barang jadi",
  defect: "Nilai menurut catatan barang cacat",
};

function stockAccountCardData(row: StockAccountRow): InventoryCardData {
  return { ...row, stockLabel: STOCK_LABEL[row.kind] };
}

function InventoryCard({ row, asOf, segmentStart }: { row: InventoryCardData; asOf: string; segmentStart: string }) {
  return (
    <Card className="flex flex-col gap-3" data-testid="reconciliation-inventory">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link href={`/accounting/ledger?account=${row.accountCode}&from=${segmentStart}&to=${asOf}`} className="hover:underline">
          <span className="tabular-nums text-neutral-600">{row.accountCode}</span> <span className="font-medium text-neutral-900">{row.accountName}</span>
        </Link>
        <StatusBadge status={row.status} />
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-base">
        <dt className="text-neutral-600">Saldo buku besar</dt>
        <dd className="text-right">
          <Amount value={row.ledger} />
        </dd>
        <dt className="text-neutral-600">{row.stockLabel}</dt>
        <dd className="text-right">
          <Amount value={row.stockValue} />
        </dd>
        {row.notJournaled.map((item) => (
          <div key={item.label} className="contents">
            <dt className="pl-3 text-sm text-neutral-600">Tidak dijurnal: {item.label}</dt>
            <dd className="text-right text-sm">
              <Amount value={item.value} />
            </dd>
          </div>
        ))}
        <dt className="font-medium text-neutral-900">Selisih</dt>
        <dd className="text-right font-medium" data-testid="reconciliation-material-difference">
          <Amount value={row.difference} />
        </dd>
      </dl>
    </Card>
  );
}

function wipNote(row: WipBatchRow): string | null {
  if (row.status === "mismatch") {
    return row.valueMissing
      ? "Nilai stok salah satu penerimaan batch ini tidak ditemukan. Lihat daftar posting yang perlu dicek."
      : "Jurnal batch ini belum lengkap. Lihat daftar posting yang perlu dicek.";
  }
  if (row.status === "review") return "Batch ini mulai sebelum pembukuan. Cocokkan dengan saldo awal barang dalam proses.";
  if (row.beforeBooks !== 0) return "Sebagian biaya berasal dari sebelum pembukuan. Di buku resmi sudah masuk saldo awal, di bulan uji coba memang tidak dijurnal.";
  return null;
}

function BatchLink({ row }: { row: WipBatchRow }) {
  return (
    <Link href={`/production/${row.batchId}`} className="font-medium text-neutral-900 hover:underline">
      {row.batchNo}
    </Link>
  );
}

function WipBatches({ rows }: { rows: WipBatchRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Tidak ada batch yang masih dalam proses" description="Batch yang sudah selesai atau ditutup tidak ditampilkan lagi." />;
  }
  return (
    <>
      <CardList>
        {rows.map((row) => {
          const note = wipNote(row);
          return (
            <li key={row.batchId} data-testid="reconciliation-wip-card">
              <Card className="flex flex-col gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <BatchLink row={row} />
                  <StatusBadge status={row.status} />
                </div>
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-base">
                  <dt className="text-neutral-600">Sisa biaya (aplikasi)</dt>
                  <dd className="text-right">
                    <Amount value={row.appWip} />
                  </dd>
                  <dt className="text-neutral-600">Saldo jurnal batch</dt>
                  <dd className="text-right">
                    <Amount value={row.ledger} />
                  </dd>
                  {row.beforeBooks !== 0 && (
                    <>
                      <dt className="text-neutral-600">Dari sebelum pembukuan</dt>
                      <dd className="text-right">
                        <Amount value={row.beforeBooks} />
                      </dd>
                    </>
                  )}
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
        <caption className="sr-only">Barang dalam proses per batch produksi</caption>
        <TableHead>
          <Th scope="col">Batch</Th>
          <Th scope="col" className="text-right">
            Sisa biaya (aplikasi)
          </Th>
          <Th scope="col" className="text-right">
            Saldo jurnal batch
          </Th>
          <Th scope="col" className="text-right">
            Selisih
          </Th>
          <Th scope="col">Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => {
            const note = wipNote(row);
            return (
              <Tr key={row.batchId} data-testid="reconciliation-wip-row">
                <Td>
                  <BatchLink row={row} />
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Amount value={row.appWip} />
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Amount value={row.ledger} />
                  {row.beforeBooks !== 0 && <span className="block text-sm text-neutral-600">dari sebelum pembukuan {formatBalance(row.beforeBooks)}</span>}
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
  );
}

function payableNote(row: PayableRow): string | null {
  const notes: string[] = [];
  if (row.notReceived !== 0) notes.push("selisih karena barang belum diterima (utang diakui saat barang diterima)");
  if (row.status === "review") notes.push("sebagian kejadian sebelum pembukuan dimulai, cocokkan dengan saldo awal pemasok ini");
  if (row.status === "mismatch") notes.push("periksa posting yang perlu dicek di Jurnal umum");
  return notes.length > 0 ? notes.join("; ") : null;
}

function DocumentLink({ row }: { row: PayableRow }) {
  return (
    <Link href={`/purchases/${row.purchaseId}`} className="font-medium text-neutral-900 hover:underline">
      {row.purchaseNo}
    </Link>
  );
}

function LedgerBreakdown({ row }: { row: PayableRow }) {
  const parts = [
    row.ledgerPayable !== 0 ? `utang ${formatBalance(row.ledgerPayable)}` : null,
    row.ledgerAdvance !== 0 ? `uang muka ${formatBalance(row.ledgerAdvance)}` : null,
    row.ledgerClaim !== 0 ? `piutang klaim ${formatBalance(row.ledgerClaim)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? <span className="block text-sm text-neutral-600">{parts.join(", ")}</span> : null;
}

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requirePermission("accounting.view");
  const raw = await searchParams;
  const today = jakartaDate();
  const requested = Array.isArray(raw.date) ? raw.date[0] : raw.date;
  const asOf = requested && isCalendarDate(requested) ? requested : today;
  const rawBiteship = Array.isArray(raw.biteship) ? raw.biteship[0] : raw.biteship;
  const biteshipTyped = parseTypedBalance(rawBiteship);
  const biteshipInvalid = Boolean(rawBiteship?.trim()) && biteshipTyped === null;
  const report = await getReconciliation(asOf, undefined, biteshipTyped);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/reconciliation")} />
      <PageHeader
        title="Rekonsiliasi"
        description={`Mencocokkan buku besar dengan catatan stok, produksi, tagihan pemasok, dan pesanan, per ${formatDay(asOf)}.`}
      />
      <form method="GET" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end lg:max-w-2xl" aria-label="Filter rekonsiliasi">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reconciliation-date">Per tanggal</Label>
          <Input id="reconciliation-date" name="date" type="date" defaultValue={asOf} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reconciliation-biteship">Saldo dashboard Biteship (opsional)</Label>
          <Input
            id="reconciliation-biteship"
            name="biteship"
            inputMode="text"
            placeholder="contoh 1.250.000"
            defaultValue={rawBiteship ?? ""}
            aria-invalid={biteshipInvalid || undefined}
            aria-describedby={biteshipInvalid ? "reconciliation-biteship-error" : undefined}
          />
          {biteshipInvalid && (
            <p id="reconciliation-biteship-error" role="alert" className="text-sm text-danger-700">
              Format saldo tidak dikenali. Tulis angka rupiah tanpa koma, misalnya 1.250.000.
            </p>
          )}
        </div>
        <div>
          <Button type="submit">Tampilkan</Button>
        </div>
      </form>
      <p className="mb-6 text-sm text-neutral-600" data-testid="reconciliation-books-note">
        {booksNote(report)}
      </p>

      <section aria-labelledby="reconciliation-materials" className="mb-8 flex flex-col gap-3">
        <h2 id="reconciliation-materials" className="text-lg font-semibold text-neutral-900">
          Persediaan
        </h2>
        <p className="text-sm text-neutral-600">
          Saldo akun persediaan dibandingkan dengan catatan di aplikasi: stok kain dan aksesoris (termasuk pemakaian produksi), barang dalam proses, barang jadi, dan barang cacat. Barang terjual yang belum dikirim dicocokkan per pesanan di bagian Penjualan.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {report.materials.map((row) => (
            <InventoryCard key={row.accountCode} row={materialCardData(row)} asOf={asOf} segmentStart={report.segmentStart} />
          ))}
          {report.stockAccounts.map((row) => (
            <InventoryCard key={row.accountCode} row={stockAccountCardData(row)} asOf={asOf} segmentStart={report.segmentStart} />
          ))}
        </div>
      </section>

      <section aria-labelledby="reconciliation-wip" className="mb-8 flex flex-col gap-3">
        <h2 id="reconciliation-wip" className="text-lg font-semibold text-neutral-900">
          Barang dalam proses per batch
        </h2>
        <p className="text-sm text-neutral-600">
          Biaya yang masih tertahan di tiap batch yang belum selesai, dicocokkan dengan jurnalnya. Batch yang sudah selesai atau ditutup tidak ditampilkan lagi.
        </p>
        <WipBatches rows={report.wipBatches} />
      </section>

      <section aria-labelledby="reconciliation-sales" className="mb-8 flex flex-col gap-3">
        <h2 id="reconciliation-sales" className="text-lg font-semibold text-neutral-900">
          Penjualan
        </h2>
        <p className="text-sm text-neutral-600">
          Per pesanan: saldo yang menurut catatan pesanan, pembayaran, dan pengiriman masih tersimpan di akun ini, dibandingkan dengan jurnal pesanan tersebut. Pesanan yang tidak cocok biasanya punya posting yang perlu dicek.
        </p>
        <SalesChecks checks={report.salesChecks} asOf={asOf} segmentStart={report.segmentStart} />
      </section>

      <section aria-labelledby="reconciliation-biteship-heading" className="mb-8 flex flex-col gap-3">
        <h2 id="reconciliation-biteship-heading" className="text-lg font-semibold text-neutral-900">
          Saldo Biteship
        </h2>
        <p className="text-sm text-neutral-600">Saldo Biteship di buku dibandingkan dengan saldo yang Anda isi dari dashboard Biteship per tanggal yang sama.</p>
        <div className="md:max-w-xl">
          <BiteshipCard check={report.biteship} asOf={asOf} segmentStart={report.segmentStart} />
        </div>
      </section>

      <section aria-labelledby="reconciliation-payables" className="flex flex-col gap-3">
        <h2 id="reconciliation-payables" className="text-lg font-semibold text-neutral-900">
          Utang pemasok per dokumen pembelian
        </h2>
        <p className="text-sm text-neutral-600">
          Sisa tagihan di aplikasi dibandingkan dengan saldo buku (utang dikurangi uang muka dan piutang klaim). Tagihan dokumen yang masih terbuka sudah dihitung penuh sejak dipesan, sedangkan utang di buku baru diakui saat barang diterima, jadi selisih sebesar barang yang belum diterima memang wajar. Tagihan mengikuti status dokumen saat ini.
        </p>
        <Card className="flex flex-col gap-1 text-base" data-testid="reconciliation-payable-summary">
          <div className="flex justify-between gap-3">
            <span className="text-neutral-600">Saldo utang usaha pemasok bahan di buku besar</span>
            <Amount value={report.payableLedgerTotal} />
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-neutral-600">Di luar dokumen pembelian (jurnal manual, saldo awal)</span>
            <Amount value={report.payableOutsideDocuments} />
          </div>
        </Card>

        {report.payables.length === 0 ? (
          <EmptyState title="Belum ada dokumen pembelian untuk dicocokkan" description="Dokumen muncul di sini setelah ada pembayaran, penerimaan barang, atau jurnalnya." />
        ) : (
          <>
            <CardList>
              {report.payables.map((row) => {
                const note = payableNote(row);
                return (
                  <li key={row.purchaseId} data-testid="reconciliation-payable-card">
                    <Card className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <DocumentLink row={row} />
                          <span className="block text-sm text-neutral-600">{row.supplierName}</span>
                        </div>
                        <StatusBadge status={row.status} />
                      </div>
                      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-base">
                        <dt className="text-neutral-600">Sisa tagihan (aplikasi)</dt>
                        <dd className="text-right">
                          <Amount value={row.appBalance} />
                        </dd>
                        <dt className="text-neutral-600">Saldo buku</dt>
                        <dd className="text-right">
                          <Amount value={row.ledgerBalance} />
                        </dd>
                        <dt className="text-neutral-600">Belum diterima</dt>
                        <dd className="text-right">
                          <Amount value={row.notReceived} />
                        </dd>
                        <dt className="font-medium text-neutral-900">Selisih</dt>
                        <dd className="text-right font-medium">
                          <Amount value={row.difference} />
                        </dd>
                      </dl>
                      <LedgerBreakdown row={row} />
                      {note && <p className="text-sm text-neutral-600">{note}</p>}
                    </Card>
                  </li>
                );
              })}
            </CardList>
            <TableContainer>
              <caption className="sr-only">Utang pemasok per dokumen pembelian</caption>
              <TableHead>
                <Th scope="col">Dokumen</Th>
                <Th scope="col" className="text-right">
                  Sisa tagihan (aplikasi)
                </Th>
                <Th scope="col" className="text-right">
                  Saldo buku
                </Th>
                <Th scope="col" className="text-right">
                  Belum diterima
                </Th>
                <Th scope="col" className="text-right">
                  Selisih
                </Th>
                <Th scope="col">Status</Th>
              </TableHead>
              <tbody>
                {report.payables.map((row) => {
                  const note = payableNote(row);
                  return (
                    <Tr key={row.purchaseId} data-testid="reconciliation-payable-row">
                      <Td>
                        <DocumentLink row={row} />
                        <span className="block text-sm text-neutral-600">{row.supplierName}</span>
                      </Td>
                      <Td className="whitespace-nowrap text-right">
                        <Amount value={row.appBalance} />
                      </Td>
                      <Td className="whitespace-nowrap text-right">
                        <Amount value={row.ledgerBalance} />
                        <LedgerBreakdown row={row} />
                      </Td>
                      <Td className="whitespace-nowrap text-right">
                        <Amount value={row.notReceived} />
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
    </>
  );
}

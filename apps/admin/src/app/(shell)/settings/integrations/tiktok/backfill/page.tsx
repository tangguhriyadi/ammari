import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Breadcrumb, Card, CardList, EmptyState, PageHeader, TableContainer, TableHead, Td, Th, Tr, type BadgeVariant } from "@ammari/ui";
import { formatDate, formatDateTime, formatNumber, formatRupiah } from "@ammari/ui/lib";
import { getTikTokBackfillPreview, getTikTokConnectionView, type TikTokBackfillView } from "@ammari/commerce/tiktok";
import type { TikTokApplyState, TikTokBackfillState } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { defaultDb } from "@/lib/db";
import { TIKTOK_INTEGRATION_PATH, TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TIKTOK_HELD_REASON_LABELS } from "@/lib/integrations/tiktok-messages";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { TikTokBackfillActions } from "../_components/tiktok-backfill-actions";

// Pratinjau riwayat TikTok (docs/plans/tiktok-shop-integration.md T9): the dry run of the backfill.
// What "Terapkan riwayat" would do with every order the backfill stored first: hand-typed orders
// matched by number and enriched (linked, TikTok's ship date, status forward, number corrected), new
// orders created (stock leaves), held and skipped ones, and hand-typed TikTok orders TikTok never
// returned. Computed at read time with the commit's own rules. integrations.manage on the server.

const STATE: Record<TikTokBackfillState, { label: string; variant: BadgeVariant }> = {
  fetching: { label: "Sedang dibaca", variant: "warning" },
  fetched: { label: "Siap dipratinjau", variant: "success" },
  confirmed: { label: "Sudah diterapkan", variant: "neutral" },
};

const TIKTOK_STATUS: Record<string, string> = {
  UNPAID: "Belum dibayar",
  ON_HOLD: "Ditahan TikTok",
  AWAITING_SHIPMENT: "Menunggu dikirim",
  PARTIALLY_SHIPPING: "Dikirim sebagian",
  AWAITING_COLLECTION: "Menunggu kurir",
  IN_TRANSIT: "Dalam perjalanan",
  DELIVERED: "Sampai",
  COMPLETED: "Selesai",
  CANCELLED: "Dibatalkan",
};

const APPLIED: Record<TikTokApplyState, string> = {
  applied: "Masuk admin",
  held: "Ditahan",
  skipped_unpaid: "Dilewati (belum dibayar)",
  skipped_undone: "Dilewati (dibatalkan)",
};

function when(date: Date | null, empty = "Belum ada"): string {
  return date ? `${formatDateTime(date)} WIB` : empty;
}

function tiktokStatus(status: string): string {
  return TIKTOK_STATUS[status] ?? status;
}

interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

/** One list in both layouts: cards below md (CardList), a table from md up (TableContainer). */
function RowsSection<T>({ id, title, description, total, rows, rowKey, columns }: { id: string; title: string; description: string; total: number; rows: T[]; rowKey: (row: T) => string; columns: Column<T>[] }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold text-neutral-900">
          {title} ({formatNumber(total)})
        </h2>
        <p className="text-sm text-neutral-600">{description}</p>
        {total > rows.length && <p className="text-sm text-neutral-600">Menampilkan {formatNumber(rows.length)} pertama.</p>}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600">Tidak ada.</p>
      ) : (
        <>
          <CardList>
            {rows.map((row) => (
              <li key={rowKey(row)}>
                <Card className="flex flex-col gap-1">
                  {columns.map((column) => (
                    <div key={column.header} className="flex flex-col text-sm">
                      <span className="text-neutral-600">{column.header}</span>
                      <span className="min-w-0 break-words text-neutral-900">{column.cell(row)}</span>
                    </div>
                  ))}
                </Card>
              </li>
            ))}
          </CardList>
          <TableContainer>
            <TableHead>
              {columns.map((column) => (
                <Th key={column.header}>{column.header}</Th>
              ))}
            </TableHead>
            <tbody>
              {rows.map((row) => (
                <Tr key={rowKey(row)}>
                  {columns.map((column) => (
                    <Td key={column.header} className="text-sm text-neutral-800">
                      {column.cell(row)}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}
    </section>
  );
}

function OrderLink({ orderId, orderNo }: { orderId: string; orderNo: string }) {
  return (
    <Link href={`/orders/${orderId}`} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">
      {orderNo}
    </Link>
  );
}

const mono = (value: string) => <span className="font-mono break-all">{value}</span>;

function Progress({ backfill }: { backfill: TikTokBackfillView }) {
  const items: [string, Date | null][] = [
    ["Pesanan", backfill.ordersDoneUntil],
    ["Retur", backfill.returnsDoneUntil],
    ["Pembatalan", backfill.cancellationsDoneUntil],
    ["Laporan keuangan", backfill.statementsDoneUntil],
    ["Pencairan", backfill.paymentsDoneUntil],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      {items.map(([label, at]) => (
        <div key={label} className="flex flex-wrap gap-x-2">
          <dt className="text-neutral-600">{label} terbaca sampai</dt>
          <dd className="font-medium text-neutral-900">{at && at.getTime() >= backfill.untilTime.getTime() ? "Selesai" : when(at, "Belum mulai")}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function TikTokBackfillPage() {
  await requirePermission(TIKTOK_PERMISSION);
  const [preview, connection] = await Promise.all([getTikTokBackfillPreview(defaultDb), getTikTokConnectionView(defaultDb)]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs(TIKTOK_INTEGRATION_PATH), { label: "Pratinjau riwayat" }]} />
      <PageHeader title="Pratinjau riwayat TikTok" description="Apa yang terjadi pada pesanan TikTok sejak awal pembukuan saat riwayat diterapkan. Belum ada yang berubah sebelum Terapkan riwayat ditekan." />
      {!preview ? (
        <EmptyState title="Riwayat belum diambil" description="Mulai dari halaman Integrasi TikTok Shop dengan tombol Ambil riwayat." />
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="flex flex-col gap-3 p-4 sm:p-6" data-testid="tiktok-backfill-status">
            <p className="flex flex-wrap items-center gap-2 text-sm text-neutral-900">
              <span className="font-medium">Status:</span>
              <Badge variant={STATE[preview.backfill.state].variant}>{STATE[preview.backfill.state].label}</Badge>
            </p>
            <p className="text-sm text-neutral-700">
              Riwayat {formatDate(preview.backfill.fromTime)} sampai {when(preview.backfill.untilTime)}. Diminta {when(preview.backfill.requestedAt)}
              {preview.backfill.requestedByName ? ` oleh ${preview.backfill.requestedByName}` : ""}.
              {preview.backfill.confirmedAt && ` Diterapkan ${when(preview.backfill.confirmedAt)}${preview.backfill.confirmedByName ? ` oleh ${preview.backfill.confirmedByName}` : ""}.`}
            </p>
            <Progress backfill={preview.backfill} />
            {preview.backfill.lastErrorCode && <p className="text-sm text-danger-700">Kesalahan terakhir: {preview.backfill.lastErrorCode}. Dicoba lagi pada sinkronisasi berikutnya.</p>}
            {preview.backfill.state === "fetched" && (
              <>
                {!connection?.ordersApplyEnabled && (
                  <p className="text-sm text-neutral-700">Penerapan pesanan TikTok belum aktif. Setelah riwayat diterapkan, pesanan baru berubah ketika Mulai terapkan pesanan ditekan di halaman Integrasi.</p>
                )}
                <TikTokBackfillActions mode={{ kind: "confirm", enrich: preview.counts.enrich, create: preview.counts.create, held: preview.counts.held, applyEnabled: connection?.ordersApplyEnabled === true }} />
              </>
            )}
            {preview.backfill.state === "confirmed" && (
              <p className="text-sm text-neutral-700">
                Hasil sejauh ini:{" "}
                {preview.applied.length === 0 ? "belum ada yang diterapkan (menunggu sinkronisasi berikutnya)" : preview.applied.map((row) => `${formatNumber(row.count)} ${row.state ? APPLIED[row.state] : ""}`).join("; ")}.
              </p>
            )}
          </Card>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Ringkasan riwayat TikTok">
            {[
              { label: "Dilengkapi", value: preview.counts.enrich },
              { label: "Dibuat baru", value: preview.counts.create },
              { label: "Ditahan", value: preview.counts.held },
              { label: "Dilewati", value: preview.counts.skip },
              { label: "Manual, tidak ada di TikTok", value: preview.counts.notInTikTok },
            ].map((item) => (
              <Card key={item.label} className="flex flex-col gap-1">
                <dt className="text-sm text-neutral-600">{item.label}</dt>
                <dd className="text-xl font-semibold text-neutral-900">{formatNumber(item.value)}</dd>
              </Card>
            ))}
          </dl>

          <RowsSection
            id="tiktok-backfill-enrich"
            title="Pesanan manual yang dilengkapi"
            description="Sudah dicatat manual dengan nomor TikTok yang sama. Tidak dibuat dua kali dan stoknya tidak dikurangi lagi: hanya dihubungkan, diberi tanggal kirim TikTok, dan statusnya dimajukan."
            total={preview.counts.enrich}
            rows={preview.enrich}
            rowKey={(row) => row.tiktokOrderId}
            columns={[
              { header: "Pesanan admin", cell: (row) => <OrderLink orderId={row.orderId} orderNo={row.orderNo} /> },
              { header: "No. pesanan TikTok", cell: (row) => mono(row.tiktokOrderId) },
              { header: "Status", cell: (row) => (row.statusFrom === row.statusTo ? ORDER_STATUS_LABELS[row.statusTo] : `${ORDER_STATUS_LABELS[row.statusFrom]} menjadi ${ORDER_STATUS_LABELS[row.statusTo]}`) },
              {
                header: "Yang diisi",
                cell: (row) =>
                  [row.fillsShippedAt ? "tanggal kirim TikTok" : null, row.fillsCompletedAt ? "tanggal selesai" : null, row.typedNumber !== row.tiktokOrderId ? `nomor diperbaiki (tadinya ${row.typedNumber})` : null].filter(Boolean).join(", ") || "hanya dihubungkan",
              },
            ]}
          />
          <RowsSection
            id="tiktok-backfill-create"
            title="Pesanan baru"
            description="Belum ada di admin. Akan dibuat dan stoknya dikurangi. Periksa dulu: kalau pesanan ini sebenarnya sudah dicatat manual dengan nomor yang salah ketik, batalkan pesanan manual itu sebelum Terapkan riwayat supaya tidak tercatat dua kali."
            total={preview.counts.create}
            rows={preview.create}
            rowKey={(row) => row.tiktokOrderId}
            columns={[
              { header: "No. pesanan TikTok", cell: (row) => mono(row.tiktokOrderId) },
              { header: "Tanggal pesanan", cell: (row) => formatDate(row.orderDate) },
              { header: "Status TikTok", cell: (row) => tiktokStatus(row.tiktokStatus) },
              { header: "Total", cell: (row) => `${formatRupiah(row.totalAmount)}, ${formatNumber(row.pieces)} pcs` },
              {
                header: "Catatan",
                cell: (row) =>
                  row.shippedBeforeBooks ? (
                    <Badge variant="warning">Dikirim sebelum 1 Des 2026: stok dikurangi, penjualannya tidak dijurnal</Badge>
                  ) : (
                    `Menjadi ${ORDER_STATUS_LABELS[row.statusTo]}`
                  ),
              },
            ]}
          />
          <RowsSection
            id="tiktok-backfill-held"
            title="Ditahan"
            description="Tidak diterapkan sampai penyebabnya diselesaikan. Setelah itu masuk otomatis pada sinkronisasi berikutnya."
            total={preview.counts.held}
            rows={preview.held}
            rowKey={(row) => row.tiktokOrderId}
            columns={[
              { header: "No. pesanan TikTok", cell: (row) => mono(row.tiktokOrderId) },
              { header: "Status TikTok", cell: (row) => tiktokStatus(row.tiktokStatus) },
              { header: "Alasan", cell: (row) => `${TIKTOK_HELD_REASON_LABELS[row.reason]}${row.detail ? ` (${row.detail})` : ""}` },
            ]}
          />
          <RowsSection
            id="tiktok-backfill-skip"
            title="Dilewati"
            description="Belum dibayar, atau dibatalkan sebelum masuk admin. Tidak ada yang dicatat."
            total={preview.counts.skip}
            rows={preview.skip}
            rowKey={(row) => row.tiktokOrderId}
            columns={[
              { header: "No. pesanan TikTok", cell: (row) => mono(row.tiktokOrderId) },
              { header: "Alasan", cell: (row) => (row.reason === "unpaid" ? "Belum dibayar" : "Dibatalkan") },
            ]}
          />
          <RowsSection
            id="tiktok-backfill-lonely"
            title="Pesanan manual yang tidak ditemukan di TikTok"
            description="Dicatat manual sebagai pesanan TikTok dalam rentang ini, tapi nomornya tidak dikenal TikTok. Biasanya salah ketik nomor. Cocokkan dengan daftar Pesanan baru: kalau sama, batalkan pesanan manual ini sebelum Terapkan riwayat."
            total={preview.counts.notInTikTok}
            rows={preview.notInTikTok}
            rowKey={(row) => row.orderId}
            columns={[
              { header: "Pesanan admin", cell: (row) => <OrderLink orderId={row.orderId} orderNo={row.orderNo} /> },
              { header: "Nomor yang diketik", cell: (row) => mono(row.channelOrderNo) },
              { header: "Tanggal pesanan", cell: (row) => formatDate(row.orderDate) },
              { header: "Status", cell: (row) => ORDER_STATUS_LABELS[row.status] },
            ]}
          />
        </div>
      )}
    </>
  );
}

import Link from "next/link";
import { Badge, Breadcrumb, Card, CardList, EmptyState, PageHeader, TableContainer, TableHead, Td, Th, Tr, type BadgeVariant } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { listTikTokOrderPreviews, type TikTokOrderPreviewRow, type TikTokPreviewOutcome } from "@ammari/commerce/tiktok";
import type { TikTokOrderReviewFlag } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { defaultDb } from "@/lib/db";
import { TIKTOK_INTEGRATION_PATH, TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { rootCrumbs } from "@/lib/nav/breadcrumb";

// Pratinjau pesanan TikTok (docs/plans/tiktok-shop-integration.md §10 T4: the dry-run view "Akan
// dibuat / ditahan"). Read only: what T5 would do with each stored TikTok order. Nothing here creates
// an admin order or moves stock. integrations.manage on the server.

const STATUS_LABELS: Record<string, string> = {
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

const FLAG_LABELS: Record<TikTokOrderReviewFlag, string> = {
  tiktok_snapshot_conflict: "Dua versi berbeda di waktu yang sama",
  tiktok_left_terminal: "Keluar dari status akhir",
};

function outcomeView(outcome: TikTokPreviewOutcome): { label: string; variant: BadgeVariant; detail: string | null } {
  switch (outcome.kind) {
    case "create":
      return { label: "Akan dibuat", variant: "success", detail: outcome.reviewPartialShipping ? "Perlu dicek: lebih dari satu paket" : null };
    case "update":
      return { label: "Akan dicocokkan", variant: "success", detail: outcome.reviewPartialShipping ? "Sudah ada di admin. Perlu dicek: lebih dari satu paket" : "Sudah ada di admin (dibuat manual)" };
    case "skip":
      return { label: "Dilewati", variant: "neutral", detail: outcome.reason === "unpaid" ? "Belum dibayar" : "Dibatalkan sebelum masuk admin" };
    case "held":
      switch (outcome.reason) {
        case "unknown_sku":
          return { label: "Ditahan", variant: "warning", detail: `SKU belum dipetakan${outcome.detail ? `: ${outcome.detail}` : ""}` };
        case "money_format":
          return { label: "Ditahan", variant: "danger", detail: `Jumlah uang bukan rupiah bulat${outcome.detail ? ` (${outcome.detail})` : ""}` };
        case "unknown_status":
          return { label: "Ditahan", variant: "danger", detail: `Status TikTok tidak dikenal${outcome.detail ? `: ${outcome.detail}` : ""}` };
      }
  }
}

function when(date: Date | null): string {
  return date ? `${formatDateTime(date)} WIB` : "Belum ada";
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function Flags({ row }: { row: TikTokOrderPreviewRow }) {
  if (row.reviewFlags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {row.reviewFlags.map((flag) => (
        <Badge key={flag} variant="danger">
          {FLAG_LABELS[flag] ?? flag}
        </Badge>
      ))}
    </span>
  );
}

export default async function TikTokOrderPreviewPage() {
  await requirePermission(TIKTOK_PERMISSION);
  const preview = await listTikTokOrderPreviews(defaultDb);
  const { counts } = preview;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs(TIKTOK_INTEGRATION_PATH), { label: "Pratinjau pesanan" }]} />
      <PageHeader
        title="Pratinjau pesanan TikTok"
        description="Uji coba: pesanan TikTok sudah dibaca, tetapi belum dibuat di admin dan stok belum berubah. Halaman ini menunjukkan apa yang akan terjadi saat pesanan mulai dimasukkan."
      />
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Ringkasan pratinjau">
          {[
            { label: "Akan dibuat", value: counts.create },
            { label: "Akan dicocokkan", value: counts.update },
            { label: "Ditahan", value: counts.held },
            { label: "Dilewati", value: counts.skip },
          ].map((item) => (
            <Card key={item.label} className="flex flex-col gap-1">
              <dt className="text-sm text-neutral-600">{item.label}</dt>
              <dd className="text-xl font-semibold text-neutral-900">{formatNumber(item.value)}</dd>
            </Card>
          ))}
        </dl>
        <p className="text-sm text-neutral-600">
          Menampilkan {formatNumber(preview.rows.length)} dari {formatNumber(preview.total)} pesanan TikTok yang terakhir berubah. SKU yang belum dipetakan diselesaikan di{" "}
          <Link href={`${TIKTOK_INTEGRATION_PATH}/sku-mappings`} className="font-medium text-brand hover:underline">
            Pemetaan SKU TikTok
          </Link>
          .
        </p>

        {preview.rows.length === 0 ? (
          <EmptyState title="Belum ada pesanan TikTok" description="Pesanan muncul di sini setelah sinkronisasi berjalan dengan toko yang terhubung." />
        ) : (
          <>
            <CardList>
              {preview.rows.map((row) => {
                const view = outcomeView(row.outcome);
                return (
                  <li key={row.tiktokOrderId}>
                    <Card className="flex flex-col gap-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-mono text-base font-semibold break-all text-neutral-900">{row.tiktokOrderId}</span>
                        <Badge variant={view.variant}>{view.label}</Badge>
                      </div>
                      {view.detail && <span className="text-sm break-words text-neutral-700">{view.detail}</span>}
                      <span className="text-sm text-neutral-600">
                        {statusLabel(row.status)}, {formatNumber(row.lineCount)} barang
                      </span>
                      <span className="text-sm text-neutral-600">Diperbarui {when(row.latestUpdateTime)}</span>
                      {row.hasBuyerMessage && <span className="text-sm text-neutral-600">Ada catatan pembeli</span>}
                      <Flags row={row} />
                    </Card>
                  </li>
                );
              })}
            </CardList>
            <TableContainer>
              <TableHead>
                <Th>No. pesanan TikTok</Th>
                <Th>Status TikTok</Th>
                <Th>Barang</Th>
                <Th>Diperbarui</Th>
                <Th>Pratinjau</Th>
              </TableHead>
              <tbody>
                {preview.rows.map((row) => {
                  const view = outcomeView(row.outcome);
                  return (
                    <Tr key={row.tiktokOrderId}>
                      <Td className="font-mono text-sm text-neutral-900">{row.tiktokOrderId}</Td>
                      <Td className="text-neutral-700">{statusLabel(row.status)}</Td>
                      <Td className="text-neutral-700">
                        {formatNumber(row.lineCount)}
                        {row.hasBuyerMessage && <span className="block text-sm text-neutral-600">Ada catatan pembeli</span>}
                      </Td>
                      <Td className="text-sm text-neutral-700">{when(row.latestUpdateTime)}</Td>
                      <Td>
                        <div className="flex flex-col gap-1">
                          <Badge variant={view.variant}>{view.label}</Badge>
                          {view.detail && <span className="max-w-xs text-sm break-words text-neutral-700">{view.detail}</span>}
                          <Flags row={row} />
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </TableContainer>
          </>
        )}
      </div>
    </>
  );
}

import { Badge, Card } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { getTikTokConnectionView, getTikTokStockPushHealth, getTikTokStockSyncPreview, tiktokStockPushGate } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { defaultDb } from "@/lib/db";
import { TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TIKTOK_STOCK_PUSH_ERROR_LABELS, TIKTOK_STOCK_PUSH_GATE_LABELS } from "@/lib/integrations/tiktok-messages";
import { TikTokStockPushRetry } from "./_components/tiktok-stock-push-retry";
import { TikTokStockPreviewList } from "./_components/tiktok-stock-preview-list";
import { TikTokStockSyncToggle } from "./_components/tiktok-stock-sync-toggle";

// Integrasi > TikTok Shop > Sinkron stok (docs/plans/tiktok-stock-sync.md §6, S1): the switch
// "Sinkronkan stok ke TikTok" (ON only while "Mulai terapkan pesanan" is ON, rule R1) and the preview
// per TikTok SKU, "Stok TikTok sekarang → akan menjadi". integrations.manage on the server. S2 adds the
// push's health: last successful push, variants waiting, automatic retries, SKUs TikTok refused (with
// "Kirim ulang"), and why nothing is sent when the gate is closed.

/** A variant waiting longer than this is called out (plan §7 "Health"). */
const PENDING_WARN_MS = 30 * 60_000;

const LISTING_SCOPES: Record<string, string> = { "seller.product.basic": "Produk", "seller.logistics": "Pengiriman" };

function when(date: Date | null, empty = "Belum pernah"): string {
  return date ? `${formatDateTime(date)} WIB` : empty;
}

export default async function TikTokStockSyncPage() {
  await requirePermission(TIKTOK_PERMISSION);
  const connection = await getTikTokConnectionView(defaultDb);
  const [preview, health, gate] = await Promise.all([
    getTikTokStockSyncPreview(defaultDb, { connectionId: connection?.id ?? null }),
    getTikTokStockPushHealth(defaultDb, connection?.id ?? null),
    tiktokStockPushGate(defaultDb),
  ]);
  const pendingOld = health.oldestPendingAgeMs !== null && health.oldestPendingAgeMs > PENDING_WARN_MS;
  const canRetry = health.failed.some((row) => row.action !== "retry");
  const active = connection?.status === "active";
  const ordersOn = connection?.ordersApplyEnabled === true;
  const stockOn = connection?.stockSyncEnabled === true;
  const missingScopes = connection ? Object.keys(LISTING_SCOPES).filter((scope) => !connection.grantedScopes.includes(scope)).map((scope) => LISTING_SCOPES[scope]) : [];
  const disabledReason = !stockOn && !active ? "Hubungkan TikTok Shop dulu." : !stockOn && !ordersOn ? "Aktifkan “Mulai terapkan pesanan” dulu (tab Koneksi). Tanpa itu penjualan TikTok tidak mengurangi stok Ammari, dan stok TikTok akan naik lagi." : null;

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex max-w-3xl flex-col gap-3 p-4 sm:p-6">
        <section aria-labelledby="tiktok-stock-switch-heading" className="flex flex-col gap-3">
          <h2 id="tiktok-stock-switch-heading" className="text-lg font-semibold text-neutral-900">
            Sinkronkan stok ke TikTok
          </h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-neutral-900">
            <span className="font-medium">Status:</span>
            <Badge variant={stockOn ? "success" : "neutral"}>{stockOn ? "Aktif" : "Belum aktif"}</Badge>
          </p>
          <p className="text-sm text-neutral-600">
            Stok yang dikirim = stok fisik dikurangi stok yang ditahan checkout website yang belum dibayar, dan dikurangi pesanan TikTok yang sudah dibayar tapi belum masuk admin. Stok di TikTok Seller Center akan ditimpa. SKU TikTok yang tidak cocok dengan SKU Ammari tidak disentuh.
          </p>
          {connection?.stockSyncChangedAt && <p className="text-sm text-neutral-600">Terakhir diubah {when(connection.stockSyncChangedAt)}.</p>}
          <TikTokStockSyncToggle enabled={stockOn} disabled={!stockOn && disabledReason !== null} reason={stockOn ? null : disabledReason} />
        </section>
      </Card>

      {stockOn && (
        <Card className="flex max-w-3xl flex-col gap-3 p-4 sm:p-6">
          <section aria-labelledby="tiktok-stock-health-heading" className="flex flex-col gap-3" data-testid="tiktok-stock-health">
            <h2 id="tiktok-stock-health-heading" className="text-lg font-semibold text-neutral-900">
              Pengiriman stok
            </h2>
            <dl className="flex flex-col gap-1 text-sm text-neutral-700 sm:flex-row sm:flex-wrap sm:gap-x-6">
              <div className="flex gap-1">
                <dt>Terakhir terkirim:</dt>
                <dd className="font-medium text-neutral-900">{when(health.lastPushedAt)}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Menunggu dikirim:</dt>
                <dd className="font-medium text-neutral-900">{formatNumber(health.pendingVariants)} varian</dd>
              </div>
              <div className="flex gap-1">
                <dt>Dicoba ulang otomatis:</dt>
                <dd className="font-medium text-neutral-900">{formatNumber(health.retrying)} varian</dd>
              </div>
              <div className="flex gap-1">
                <dt>Ditolak TikTok:</dt>
                <dd className="font-medium text-neutral-900">{formatNumber(health.failed.length)} SKU</dd>
              </div>
              {health.lastDrainErrorCode && (
                <div className="flex gap-1">
                  <dt>Kesalahan terakhir:</dt>
                  <dd className="font-medium text-neutral-900">{health.lastDrainErrorCode}</dd>
                </div>
              )}
            </dl>
            {!gate.ok && gate.reason !== "switch_off" && (
              <p role="status" className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
                Stok belum dikirim: {TIKTOK_STOCK_PUSH_GATE_LABELS[gate.reason]}
              </p>
            )}
            {pendingOld && (
              <p role="status" className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
                Ada perubahan stok yang menunggu lebih dari 30 menit (sejak {when(health.oldestPendingAt)}). Cek kesalahan di bawah atau log server.
              </p>
            )}
            {health.failed.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-neutral-900">SKU yang gagal dikirim</h3>
                <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200" aria-label="SKU yang gagal dikirim">
                  {health.failed.map((row) => (
                    <li key={row.tiktokSkuId} className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <div className="flex min-w-0 flex-col">
                        <span className="font-medium text-neutral-900 [overflow-wrap:anywhere]">
                          {row.productTitle ?? row.tiktokProductId}
                          {row.skuLabel ? ` · ${row.skuLabel}` : ""}
                        </span>
                        <span className="text-neutral-600 [overflow-wrap:anywhere]">
                          {row.sellerSku ?? "Tanpa SKU penjual"} · SKU TikTok {row.tiktokSkuId}
                        </span>
                      </div>
                      <div className="flex flex-col sm:max-w-sm sm:text-right">
                        <span className="text-neutral-900">{TIKTOK_STOCK_PUSH_ERROR_LABELS[row.code] ?? "Ditolak TikTok"}</span>
                        <span className="text-neutral-600">
                          Kode {row.code} · {when(row.at)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                {canRetry && <TikTokStockPushRetry />}
              </div>
            )}
          </section>
        </Card>
      )}

      <section aria-labelledby="tiktok-stock-preview-heading" className="flex flex-col gap-3">
        <h2 id="tiktok-stock-preview-heading" className="text-lg font-semibold text-neutral-900">
          Pratinjau per SKU
        </h2>
        <dl className="flex flex-col gap-1 text-sm text-neutral-700 sm:flex-row sm:flex-wrap sm:gap-x-6">
          <div className="flex gap-1">
            <dt>Terakhir dibaca dari TikTok:</dt>
            <dd className="font-medium text-neutral-900">{when(preview.lastReadOkAt)}</dd>
          </div>
          {preview.lastReadErrorCode && (
            <div className="flex gap-1">
              <dt>Kesalahan terakhir:</dt>
              <dd className="font-medium text-neutral-900">{preview.lastReadErrorCode}</dd>
            </div>
          )}
          <div className="flex gap-1">
            <dt>Akan berubah:</dt>
            <dd className="font-medium text-neutral-900">{formatNumber(preview.counts.change)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Sudah sama:</dt>
            <dd className="font-medium text-neutral-900">{formatNumber(preview.counts.same)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Ditahan:</dt>
            <dd className="font-medium text-neutral-900">{formatNumber(preview.counts.held)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Belum dipetakan:</dt>
            <dd className="font-medium text-neutral-900">{formatNumber(preview.counts.unmapped)}</dd>
          </div>
        </dl>
        {missingScopes.length > 0 && (
          <p role="status" className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
            Izin TikTok belum lengkap untuk membaca produk dan gudang (belum ada: {missingScopes.join(", ")}). Hubungkan ulang TikTok Shop setelah izinnya disetujui.
          </p>
        )}
        {preview.unreadableHeldOrders > 0 && (
          <p role="status" className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
            {formatNumber(preview.unreadableHeldOrders)} pesanan TikTok ditahan isinya tidak terbaca, jadi semua SKU ditahan sampai pesanan itu jelas. Cek Pesanan TikTok.
          </p>
        )}
        {preview.truncated && (
          <p className="text-sm text-neutral-600">
            Menampilkan {formatNumber(preview.rows.length)} dari {formatNumber(preview.total)} SKU TikTok.
          </p>
        )}
        {preview.unattributedHeldOrders > 0 && (
          <p role="status" className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
            {formatNumber(preview.unattributedHeldOrders)} pesanan TikTok ditahan punya SKU yang belum dipetakan, jadi belum ikut dikurangi dari stok mana pun. Petakan di Pemetaan SKU.
          </p>
        )}
        <TikTokStockPreviewList rows={preview.rows} />
      </section>
    </div>
  );
}

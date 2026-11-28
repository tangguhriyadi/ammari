import { Badge, Card } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { getTikTokConnectionView, getTikTokStockSyncPreview } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { defaultDb } from "@/lib/db";
import { TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TikTokStockPreviewList } from "./_components/tiktok-stock-preview-list";
import { TikTokStockSyncToggle } from "./_components/tiktok-stock-sync-toggle";

// Integrasi > TikTok Shop > Sinkron stok (docs/plans/tiktok-stock-sync.md §6, S1): the switch
// "Sinkronkan stok ke TikTok" (ON only while "Mulai terapkan pesanan" is ON, rule R1) and the preview
// per TikTok SKU, "Stok TikTok sekarang → akan menjadi". integrations.manage on the server. S1 never
// pushes: turning the switch on only stores the flag.

const LISTING_SCOPES: Record<string, string> = { "seller.product.basic": "Produk", "seller.logistics": "Pengiriman" };

function when(date: Date | null, empty = "Belum pernah"): string {
  return date ? `${formatDateTime(date)} WIB` : empty;
}

export default async function TikTokStockSyncPage() {
  await requirePermission(TIKTOK_PERMISSION);
  const connection = await getTikTokConnectionView(defaultDb);
  const preview = await getTikTokStockSyncPreview(defaultDb, { connectionId: connection?.id ?? null });
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
          {stockOn && (
            <p role="status" className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
              Pengiriman stok ke TikTok belum berjalan. Saat ini pengaturannya hanya tersimpan sebagai aktif.
            </p>
          )}
          {connection?.stockSyncChangedAt && <p className="text-sm text-neutral-600">Terakhir diubah {when(connection.stockSyncChangedAt)}.</p>}
          <TikTokStockSyncToggle enabled={stockOn} disabled={!stockOn && disabledReason !== null} reason={stockOn ? null : disabledReason} />
        </section>
      </Card>

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

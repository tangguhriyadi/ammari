import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Card, type BadgeVariant } from "@ammari/ui";
import { formatDate, formatDateTime, formatNumber } from "@ammari/ui/lib";
import { getTikTokBackfillView, tiktokConnectionBanner } from "@ammari/commerce/tiktok";
import { ACCOUNTING_TRIAL_MONTH, type TikTokBackfillState, type TikTokConnectionStatus } from "@ammari/db/schema";
import { defaultDb } from "@/lib/db";
import { requirePermission } from "@/lib/auth/require-permission";
import { getTikTokRuntime, TIKTOK_INTEGRATION_PATH, TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TIKTOK_CONNECT_ERRORS, TIKTOK_CONNECTED_MESSAGE, TIKTOK_HELD_REASON_LABELS, TIKTOK_RECONNECTED_MESSAGE, isTikTokConnectErrorCode } from "@/lib/integrations/tiktok-messages";
import { getTikTokIntegrationPageData } from "@/lib/integrations/tiktok-queries";
import { TikTokConnectionActions } from "./_components/tiktok-connection-actions";
import { TikTokBackfillActions } from "./_components/tiktok-backfill-actions";
import { TikTokConnectionBanner } from "./_components/tiktok-connection-banner";
import { TikTokOrdersApplyToggle } from "./_components/tiktok-orders-apply-toggle";

// Administrasi > Integrasi > TikTok Shop (docs/plans/tiktok-shop-integration.md §3.1, §7.3, T2): status,
// shop, granted scopes, token expiry, health, and Hubungkan / Hubungkan ulang / Putuskan.
// integrations.manage on the server. No token or cipher is read for this page.

const STATUS: Record<TikTokConnectionStatus, { label: string; variant: BadgeVariant }> = {
  active: { label: "Terhubung", variant: "success" },
  reauth_required: { label: "Perlu dihubungkan ulang", variant: "danger" },
  deauthorized: { label: "Izin dicabut penjual", variant: "danger" },
  disconnected: { label: "Diputuskan", variant: "neutral" },
};

const BACKFILL_STATE: Record<TikTokBackfillState, { label: string; variant: BadgeVariant }> = {
  fetching: { label: "Sedang dibaca", variant: "warning" },
  fetched: { label: "Siap dipratinjau", variant: "success" },
  confirmed: { label: "Sudah diterapkan", variant: "neutral" },
};

/** Yesterday in Asia/Jakarta, "YYYY-MM-DD": the latest day a backfill may start from. */
function jakartaYesterday(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
}

const TOPIC_LABELS: Record<number, string> = {
  1: "Status pesanan",
  3: "Alamat penerima",
  6: "Izin dicabut",
  7: "Izin akan berakhir",
  11: "Pembatalan",
  12: "Retur",
};

const SCOPE_LABELS: Record<string, string> = {
  "seller.order.info": "Pesanan",
  "seller.finance.info": "Keuangan",
  "seller.return_refund.basic": "Retur dan pengembalian dana",
  "seller.shop.info": "Info toko",
  "seller.logistics": "Pengiriman",
  "seller.product.basic": "Produk",
  // Stock sync (docs/plans/tiktok-stock-sync.md): Update Inventory needs it.
  "seller.product.write": "Modifikasi produk",
  "seller.authorization.info": "Informasi resmi toko",
};

function when(date: Date | null, empty = "Belum ada"): string {
  return date ? `${formatDateTime(date)} WIB` : empty;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium text-neutral-900">{children}</dd>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-2 p-4 sm:p-6">
      <section aria-labelledby={id} className="flex flex-col gap-2">
        <h2 id={id} className="text-lg font-semibold text-neutral-900">
          {title}
        </h2>
        {children}
      </section>
    </Card>
  );
}

export default async function TikTokIntegrationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission(TIKTOK_PERMISSION);
  const search = await searchParams;
  const runtime = getTikTokRuntime({ requireServiceId: true });
  const [{ connection, connectedByName, webhookCounts, ordersCursor, failedEvents, tiktokOrderCount, unmappedSkuCount, appliedCount, heldByReason }, backfill] = await Promise.all([getTikTokIntegrationPageData(), getTikTokBackfillView(defaultDb)]);
  const now = new Date();
  const banner = tiktokConnectionBanner(connection, now);

  const connected = search.connected === "new" ? TIKTOK_CONNECTED_MESSAGE : search.connected === "again" ? TIKTOK_RECONNECTED_MESSAGE : null;
  const errorCode = isTikTokConnectErrorCode(search.error) ? search.error : null;
  const current = connection && (connection.status === "active" || connection.status === "reauth_required") ? connection : null;
  const status = connection ? STATUS[connection.status] : { label: "Belum terhubung", variant: "neutral" as const };

  return (
    <>
      <div className="flex max-w-3xl flex-col gap-6">
        {connected && (
          <p role="status" className="rounded-lg border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700">
            {connected}
          </p>
        )}
        {errorCode && (
          <p role="alert" className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
            {TIKTOK_CONNECT_ERRORS[errorCode]} <span className="whitespace-nowrap">(kode: {errorCode})</span>
          </p>
        )}
        {banner && <TikTokConnectionBanner banner={banner} linkToSettings={false} />}
        {!runtime.ok && (
          <div role="status" className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
            <p>{TIKTOK_CONNECT_ERRORS.not_configured}</p>
            <ul className="mt-1 list-disc pl-5">
              {runtime.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        <Section id="tiktok-connection-heading" title="Koneksi">
          <dl className="divide-y divide-neutral-100">
            <Row label="Status">
              <Badge variant={status.variant}>{status.label}</Badge>
            </Row>
            {connection && (
              <>
                <Row label="Toko">{connection.shopName ?? "Tanpa nama"}</Row>
                <Row label="ID toko">{connection.shopId}</Row>
                <Row label="Wilayah">{connection.region ?? "Belum ada"}</Row>
                <Row label="Terhubung sejak">
                  {when(connection.connectedAt)}
                  {connectedByName ? ` oleh ${connectedByName}` : ""}
                </Row>
                {connection.deauthorizedAt && <Row label="Izin dicabut">{when(connection.deauthorizedAt)}</Row>}
                {current && (
                  <>
                    <Row label="Token akses berlaku sampai">{when(connection.accessTokenExpiresAt)}</Row>
                    <Row label="Izin berlaku sampai">{when(connection.refreshTokenExpiresAt)}</Row>
                    <Row label="Token terakhir diperbarui">{when(connection.lastRefreshedAt)}</Row>
                  </>
                )}
              </>
            )}
          </dl>
          <div className="pt-2">
            <TikTokConnectionActions mode={current ? "reconnect" : "connect"} canDisconnect={current !== null} disabled={!runtime.ok} />
          </div>
        </Section>

        {connection && (
          <Section id="tiktok-scopes-heading" title="Izin yang diberikan">
            {connection.grantedScopes.length === 0 ? (
              <p className="text-sm text-neutral-600">TikTok tidak mengirim daftar izin.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Izin yang diberikan">
                {connection.grantedScopes.map((scope) => (
                  <li key={scope}>
                    <Badge variant="neutral" title={scope}>
                      {SCOPE_LABELS[scope] ?? scope}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {connection && (
          <Section id="tiktok-health-heading" title="Kesehatan sinkronisasi">
            <dl className="divide-y divide-neutral-100">
              <Row label="Webhook terakhir">{when(connection.lastWebhookAt)}</Row>
              <Row label="Sinkronisasi terakhir berhasil">{when(connection.lastPollOkAt)}</Row>
              <Row label="Kesalahan terakhir">{connection.lastErrorCode ? `${connection.lastErrorCode}, ${when(connection.lastErrorAt)}` : "Tidak ada"}</Row>
              <Row label="Webhook menunggu diproses">{formatNumber(webhookCounts.pending)}</Row>
              <Row label="Webhook gagal">{formatNumber(webhookCounts.failed)}</Row>
            </dl>
            {failedEvents.length > 0 && (
              <div className="flex flex-col gap-2 pt-2">
                <h3 className="text-sm font-semibold text-neutral-900">Webhook gagal terbaru</h3>
                <p className="text-sm text-neutral-600">Sudah dicoba 10 kali. Pesanannya tetap terbaca lewat sinkronisasi berkala.</p>
                <ul className="flex flex-col divide-y divide-neutral-100 rounded-lg border border-neutral-200" aria-label="Webhook gagal terbaru">
                  {failedEvents.map((event) => (
                    <li key={event.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <span className="font-medium text-neutral-900">{TOPIC_LABELS[event.type] ?? `Topik ${event.type}`}</span>
                      <span className="text-neutral-600">
                        {when(event.receivedAt)}, kode: {event.lastErrorCode ?? "tidak ada"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
        )}

        {connection && (
          <Section id="tiktok-orders-heading" title="Pesanan TikTok">
            <div className="flex flex-col gap-2" data-testid="tiktok-orders-apply">
              <p className="flex flex-wrap items-center gap-2 text-sm text-neutral-900">
                <span className="font-medium">Penerapan ke pesanan dan stok:</span>
                <Badge variant={connection.ordersApplyEnabled ? "success" : "neutral"}>{connection.ordersApplyEnabled ? "Aktif" : "Belum aktif (uji coba)"}</Badge>
              </p>
              <p className="text-sm text-neutral-600">
                {connection.ordersApplyEnabled
                  ? "Pesanan TikTok yang sudah dibayar dibuat di admin dan stoknya dikurangi. Status ikut berubah sesuai TikTok."
                  : "Pesanan TikTok dibaca dan disimpan, tetapi belum dibuat di admin dan stok belum berubah. Halaman pesanan TikTok menunjukkan mana yang akan dibuat dan mana yang ditahan."}
                {connection.ordersApplyChangedAt && ` Terakhir diubah ${when(connection.ordersApplyChangedAt)}.`}
              </p>
              {/* Stopping is always possible (a TikTok incident, a lost connection); starting needs an active one. */}
              <TikTokOrdersApplyToggle enabled={connection.ordersApplyEnabled} disabled={!connection.ordersApplyEnabled && connection.status !== "active"} />
              {!connection.ordersApplyEnabled && connection.status !== "active" && <p className="text-sm text-neutral-600">Hubungkan TikTok Shop dulu untuk mulai menerapkan pesanan.</p>}
            </div>
            <dl className="divide-y divide-neutral-100">
              <Row label="Pesanan terbaca sampai">{when(ordersCursor?.windowEnd ?? null)}</Row>
              <Row label="Sinkronisasi pesanan terakhir">{when(ordersCursor?.lastRunAt ?? null)}</Row>
              {ordersCursor?.lastErrorCode && <Row label="Kesalahan sinkronisasi pesanan">{ordersCursor.lastErrorCode}</Row>}
              <Row label="Pesanan TikTok tersimpan">{formatNumber(tiktokOrderCount)}</Row>
              <Row label="SKU TikTok belum dipetakan">{formatNumber(unmappedSkuCount)}</Row>
              <Row label="Sudah masuk admin">{formatNumber(appliedCount)}</Row>
              <Row label="Ditahan">
                {heldByReason.length === 0 ? "Tidak ada" : heldByReason.map((held) => `${formatNumber(held.count)} ${(TIKTOK_HELD_REASON_LABELS as Record<string, string>)[held.reason] ?? held.reason}`).join("; ")}
              </Row>
            </dl>
            <div className="flex flex-col gap-2 pt-2 sm:flex-row">
              <Link href={`${TIKTOK_INTEGRATION_PATH}/orders`} className="text-sm font-medium text-brand hover:underline">
                Lihat pesanan TikTok
              </Link>
              <Link href={`${TIKTOK_INTEGRATION_PATH}/sku`} className="text-sm font-medium text-brand hover:underline sm:ml-4">
                Buka Pemetaan SKU TikTok
              </Link>
              <Link href={`${TIKTOK_INTEGRATION_PATH}/finance`} className="text-sm font-medium text-brand hover:underline sm:ml-4">
                Lihat keuangan TikTok
              </Link>
            </div>
          </Section>
        )}

        {connection && (
          <Section id="tiktok-backfill-heading" title="Riwayat sejak awal pembukuan">
            <div className="flex flex-col gap-2" data-testid="tiktok-backfill">
              <p className="text-sm text-neutral-600">
                Membaca pesanan, retur, laporan keuangan, dan pencairan TikTok sejak 1 Desember 2026 (paling awal). Pesanan yang sudah dicatat manual dicocokkan dengan nomor TikTok-nya dan dilengkapi, tidak dibuat dua kali. Tidak ada yang berubah sebelum pratinjaunya dicek dan Terapkan riwayat ditekan.
              </p>
              {backfill ? (
                <dl className="divide-y divide-neutral-100">
                  <Row label="Status">
                    <Badge variant={BACKFILL_STATE[backfill.state].variant}>{BACKFILL_STATE[backfill.state].label}</Badge>
                  </Row>
                  <Row label="Rentang">
                    {formatDate(backfill.fromTime)} sampai {when(backfill.untilTime)}
                  </Row>
                  <Row label="Pesanan terbaca sampai">{backfill.ordersDoneUntil && backfill.ordersDoneUntil.getTime() >= backfill.untilTime.getTime() ? "Selesai" : when(backfill.ordersDoneUntil, "Belum mulai")}</Row>
                  {backfill.lastErrorCode && <Row label="Kesalahan terakhir">{backfill.lastErrorCode}</Row>}
                </dl>
              ) : (
                <p className="text-sm text-neutral-700">Riwayat belum diambil.</p>
              )}
              {backfill && (
                <Link href={`${TIKTOK_INTEGRATION_PATH}/backfill`} className="inline-flex min-h-11 items-center self-start text-sm font-medium text-brand hover:underline">
                  Lihat pratinjau riwayat
                </Link>
              )}
              {(!backfill || backfill.state === "confirmed") && (
                <TikTokBackfillActions mode={{ kind: "start", defaultDate: ACCOUNTING_TRIAL_MONTH, minDate: ACCOUNTING_TRIAL_MONTH, maxDate: jakartaYesterday(now) }} disabled={connection.status !== "active"} />
              )}
            </div>
          </Section>
        )}
      </div>
    </>
  );
}

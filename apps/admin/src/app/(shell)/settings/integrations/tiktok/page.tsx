import type { ReactNode } from "react";
import { Badge, Breadcrumb, Card, PageHeader, type BadgeVariant } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { tiktokConnectionBanner } from "@ammari/commerce/tiktok";
import type { TikTokConnectionStatus } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { getTikTokRuntime, TIKTOK_INTEGRATION_PATH, TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TIKTOK_CONNECT_ERRORS, TIKTOK_CONNECTED_MESSAGE, TIKTOK_RECONNECTED_MESSAGE, isTikTokConnectErrorCode } from "@/lib/integrations/tiktok-messages";
import { getTikTokIntegrationPageData } from "@/lib/integrations/tiktok-queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { TikTokConnectionActions } from "./_components/tiktok-connection-actions";
import { TikTokConnectionBanner } from "./_components/tiktok-connection-banner";

// Pengaturan > Integrasi TikTok Shop (docs/plans/tiktok-shop-integration.md §3.1, §7.3, T2): status,
// shop, granted scopes, token expiry, health, and Hubungkan / Hubungkan ulang / Putuskan.
// integrations.manage on the server. No token or cipher is read for this page.

const STATUS: Record<TikTokConnectionStatus, { label: string; variant: BadgeVariant }> = {
  active: { label: "Terhubung", variant: "success" },
  reauth_required: { label: "Perlu dihubungkan ulang", variant: "danger" },
  deauthorized: { label: "Izin dicabut penjual", variant: "danger" },
  disconnected: { label: "Diputuskan", variant: "neutral" },
};

const SCOPE_LABELS: Record<string, string> = {
  "seller.order.info": "Pesanan",
  "seller.finance.info": "Keuangan",
  "seller.return_refund.basic": "Retur dan pengembalian dana",
  "seller.shop.info": "Info toko",
  "seller.logistics": "Pengiriman",
  "seller.product.basic": "Produk",
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
  const { connection, connectedByName, webhookCounts } = await getTikTokIntegrationPageData();
  const now = new Date();
  const banner = tiktokConnectionBanner(connection, now);

  const connected = search.connected === "new" ? TIKTOK_CONNECTED_MESSAGE : search.connected === "again" ? TIKTOK_RECONNECTED_MESSAGE : null;
  const errorCode = isTikTokConnectErrorCode(search.error) ? search.error : null;
  const current = connection && (connection.status === "active" || connection.status === "reauth_required") ? connection : null;
  const status = connection ? STATUS[connection.status] : { label: "Belum terhubung", variant: "neutral" as const };

  return (
    <>
      <Breadcrumb items={rootCrumbs(TIKTOK_INTEGRATION_PATH)} />
      <PageHeader title="Integrasi TikTok Shop" description="Hubungkan toko TikTok agar pesanan, retur, dan pencairan dana masuk otomatis ke admin." />
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
          </Section>
        )}
      </div>
    </>
  );
}

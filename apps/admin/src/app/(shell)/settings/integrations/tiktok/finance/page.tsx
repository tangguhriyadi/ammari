import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Breadcrumb, Card, CardList, EmptyState, PageHeader, TableContainer, TableHead, Td, Th, Tr, type BadgeVariant } from "@ammari/ui";
import { formatDateTime, formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { TikTokFinanceHeldReason, TikTokOrderFeeHeldReason } from "@ammari/db/schema";
import { getTikTokConnectionView, TIKTOK_FINANCE_SCOPE } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { defaultDb } from "@/lib/db";
import { TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { getTikTokFinancePageData, type TikTokFinancePageData } from "@/lib/integrations/tiktok-finance-queries";
import { integrationCrumbs } from "@/lib/integrations/breadcrumb";
import { TIKTOK_TAB } from "@/lib/integrations/tabs";

// Keuangan TikTok (docs/plans/tiktok-shop-integration.md §3.5, §5.3, T7): what the finance sync read
// from TikTok (statements, payouts, estimated and actual fees) and what it held for a person. Read
// only: nothing here changes data, so nothing here is audited; the sync's own writes to an order's
// fees are in Log Aktivitas (tiktok_fees_update / tiktok_fees_hold). integrations.manage on the server.

const FEE_HELD_LABELS: Record<TikTokOrderFeeHeldReason, string> = {
  fee_type_unmapped: "Jenis biaya TikTok belum ada di tabel biaya",
  fee_negative: "Biaya bersih bernilai kredit",
  fee_sum_mismatch: "Rincian biaya tidak sama dengan totalnya",
  money_format: "Jumlah uang bukan rupiah bulat",
  not_tiktok_order: "Pesanan admin bukan pesanan TikTok",
};

const FINANCE_HELD_LABELS: Record<TikTokFinanceHeldReason, string> = {
  money_format: "Jumlah uang bukan rupiah bulat",
  currency: "Mata uang bukan IDR",
  sum_mismatch: "Total transaksi tidak sama dengan penyelesaian",
};

const CURSOR_LABELS: Record<TikTokFinancePageData["cursors"][number]["resource"], string> = {
  unsettled: "Transaksi belum selesai (perkiraan)",
  statements: "Laporan penyelesaian",
  payments: "Pencairan dana",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = { PAID: "Dibayar", PROCESSING: "Diproses", TRANSFERRING: "Ditransfer", FAILED: "Gagal" };

function when(date: Date | null): string {
  return date ? `${formatDateTime(date)} WIB` : "Belum ada";
}

function money(amount: number | null): string {
  return amount === null ? "Tidak terbaca" : formatRupiah(amount);
}

function statusLabel(status: string | null): string {
  return status ? (PAYMENT_STATUS_LABELS[status] ?? status) : "Tidak ada";
}

function statementState(row: TikTokFinancePageData["statements"][number]): { label: string; variant: BadgeVariant } {
  if (row.heldReason) return { label: FINANCE_HELD_LABELS[row.heldReason], variant: "danger" };
  if (!row.complete) return { label: "Transaksi belum lengkap", variant: "warning" };
  return { label: "Cocok", variant: "success" };
}

function payoutState(row: TikTokFinancePageData["payouts"][number]): { label: string; variant: BadgeVariant } {
  if (row.heldReason) return { label: FINANCE_HELD_LABELS[row.heldReason], variant: "danger" };
  if (row.statementCount === 0) return { label: "Belum ada laporan terkait", variant: "warning" };
  // A linked statement that is held or unreadable: the total is unknown, not different.
  if (row.statementsTotal === null) return { label: "Total laporan belum terbaca", variant: "warning" };
  return row.matches ? { label: "Sama dengan laporan", variant: "success" } : { label: "Berbeda dengan laporan", variant: "danger" };
}

function Section({ id, title, description, testId, children }: { id: string; title: string; description?: string; testId: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold text-neutral-900">
          {title}
        </h2>
        {description && <p className="text-sm text-neutral-600">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function OrderRef({ row }: { row: TikTokFinancePageData["heldOrders"][number] }) {
  if (!row.orderId) return <span className="text-sm text-neutral-600">Belum ada di admin</span>;
  return (
    <Link href={`/orders/${row.orderId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
      {row.orderNo ?? "Buka pesanan"}
    </Link>
  );
}

function heldDetail(row: TikTokFinancePageData["heldOrders"][number]): string {
  const kept = row.appliedSource ? ` Biaya yang tercatat masih ${row.appliedSource === "estimate" ? "perkiraan" : "aktual"} sebelumnya.` : " Belum ada biaya yang tercatat.";
  return `${FEE_HELD_LABELS[row.reason]}.${kept}`;
}

export default async function TikTokFinancePage() {
  await requirePermission(TIKTOK_PERMISSION);
  const [data, connection] = await Promise.all([getTikTokFinancePageData(), getTikTokConnectionView(defaultDb)]);
  const missingScope = connection !== null && !connection.grantedScopes.includes(TIKTOK_FINANCE_SCOPE);

  return (
    <>
      <Breadcrumb items={[...integrationCrumbs(TIKTOK_TAB), { label: "Keuangan TikTok" }]} />
      <PageHeader
        title="Keuangan TikTok"
        description="Laporan penyelesaian, pencairan dana, dan biaya per pesanan yang dibaca dari TikTok Shop. Biaya perkiraan diganti biaya aktual saat TikTok menyelesaikan pesanan."
      />
      <div className="flex flex-col gap-8">
        {missingScope && (
          <p role="status" className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
            Izin Keuangan TikTok belum diberikan, jadi data keuangan tidak dibaca. Pencairan dana dan biaya tetap dicatat manual sampai toko dihubungkan ulang dengan izin Keuangan.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Ringkasan biaya pesanan TikTok">
          {[
            { label: "Biaya perkiraan", value: data.fees.estimate },
            { label: "Biaya aktual", value: data.fees.actual },
            { label: "Ditahan", value: data.fees.held },
            { label: "Menunggu pesanan admin", value: data.fees.waiting },
          ].map((item) => (
            <Card key={item.label} className="flex flex-col gap-1">
              <dt className="text-sm text-neutral-600">{item.label}</dt>
              <dd className="text-xl font-semibold text-neutral-900">{formatNumber(item.value)}</dd>
            </Card>
          ))}
        </dl>

        <Card className="flex flex-col gap-2 p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-neutral-900">Sinkronisasi keuangan</h2>
          <p className="text-sm text-neutral-600">Berjalan paling sering 30 menit sekali, hanya jika izin Keuangan diberikan.</p>
          <dl className="divide-y divide-neutral-100">
            {(["unsettled", "statements", "payments"] as const).map((resource) => {
              const cursor = data.cursors.find((row) => row.resource === resource);
              return (
                <div key={resource} className="flex flex-col gap-0.5 py-2.5 sm:grid sm:grid-cols-[16rem_minmax(0,1fr)] sm:gap-4">
                  <dt className="text-sm text-neutral-600">{CURSOR_LABELS[resource]}</dt>
                  <dd className="min-w-0 text-sm font-medium break-words text-neutral-900">
                    Terakhir berhasil {when(cursor?.lastOkAt ?? null)}
                    {cursor?.lastErrorCode ? `, kesalahan terakhir: ${cursor.lastErrorCode}` : ""}
                  </dd>
                </div>
              );
            })}
          </dl>
        </Card>

        <Section id="tiktok-fees-held-heading" title="Biaya pesanan ditahan" description="Biaya pesanan ini tidak diubah sampai penyebabnya diselesaikan. Jenis biaya baru ditinjau akuntan dan ditambahkan ke tabel biaya." testId="tiktok-fees-held">
          {data.heldOrders.length === 0 ? (
            <EmptyState title="Tidak ada biaya yang ditahan" description="Semua biaya pesanan TikTok yang terbaca sudah tercatat." />
          ) : (
            <>
              <CardList>
                {data.heldOrders.map((row) => (
                  <li key={row.tiktokOrderId}>
                    <Card className="flex flex-col gap-1">
                      <span className="font-mono text-base font-semibold break-all text-neutral-900">{row.tiktokOrderId}</span>
                      <span className="text-sm break-words text-neutral-700">{heldDetail(row)}</span>
                      {row.unmappedTypes.length > 0 && <span className="font-mono text-sm break-all text-neutral-700">{row.unmappedTypes.join(", ")}</span>}
                      <OrderRef row={row} />
                    </Card>
                  </li>
                ))}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>No. pesanan TikTok</Th>
                  <Th>Alasan</Th>
                  <Th>Jenis biaya</Th>
                  <Th>Pesanan admin</Th>
                </TableHead>
                <tbody>
                  {data.heldOrders.map((row) => (
                    <Tr key={row.tiktokOrderId}>
                      <Td className="font-mono text-sm text-neutral-900">{row.tiktokOrderId}</Td>
                      <Td className="max-w-xs text-sm break-words text-neutral-700">{heldDetail(row)}</Td>
                      <Td className="font-mono text-sm break-all text-neutral-700">{row.unmappedTypes.length > 0 ? row.unmappedTypes.join(", ") : "Tidak ada"}</Td>
                      <Td>
                        <OrderRef row={row} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </TableContainer>
            </>
          )}
        </Section>

        <Section id="tiktok-statements-heading" title="Laporan penyelesaian" description={`${formatNumber(data.statements.length)} laporan terbaru. Total semua transaksi harus sama dengan jumlah penyelesaian.`} testId="tiktok-statements">
          {data.statements.length === 0 ? (
            <EmptyState title="Belum ada laporan penyelesaian" description="Laporan muncul setelah TikTok menyelesaikan pesanan dan sinkronisasi keuangan berjalan." />
          ) : (
            <>
              <CardList>
                {data.statements.map((row) => {
                  const state = statementState(row);
                  return (
                    <li key={row.statementId}>
                      <Card className="flex flex-col gap-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-base font-semibold text-neutral-900">{money(row.settlementAmount)}</span>
                          <Badge variant={state.variant}>{state.label}</Badge>
                        </div>
                        <span className="text-sm text-neutral-600">{when(row.statementTime)}</span>
                        <span className="text-sm text-neutral-600">
                          {formatNumber(row.transactionCount)} transaksi, {statusLabel(row.paymentStatus)}
                        </span>
                        <span className="font-mono text-sm break-all text-neutral-600">{row.statementId}</span>
                      </Card>
                    </li>
                  );
                })}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>Waktu laporan</Th>
                  <Th>ID laporan</Th>
                  <Th>Penyelesaian</Th>
                  <Th>Transaksi</Th>
                  <Th>Pembayaran</Th>
                  <Th>Pemeriksaan</Th>
                </TableHead>
                <tbody>
                  {data.statements.map((row) => {
                    const state = statementState(row);
                    return (
                      <Tr key={row.statementId}>
                        <Td className="text-sm text-neutral-700">{when(row.statementTime)}</Td>
                        <Td className="font-mono text-sm text-neutral-900">{row.statementId}</Td>
                        <Td className="text-sm text-neutral-900">{money(row.settlementAmount)}</Td>
                        <Td className="text-sm text-neutral-700">{formatNumber(row.transactionCount)}</Td>
                        <Td className="text-sm text-neutral-700">{statusLabel(row.paymentStatus)}</Td>
                        <Td>
                          <Badge variant={state.variant}>{state.label}</Badge>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </TableContainer>
            </>
          )}
        </Section>

        <Section id="tiktok-payouts-heading" title="Pencairan dana" description="Uang yang ditransfer TikTok ke rekening bank. Jumlahnya harus sama dengan total laporan yang dibayarnya." testId="tiktok-payouts">
          {data.payouts.length === 0 ? (
            <EmptyState title="Belum ada pencairan dana" description="Pencairan muncul setelah TikTok mentransfer saldo ke rekening." />
          ) : (
            <>
              <CardList>
                {data.payouts.map((row) => {
                  const state = payoutState(row);
                  return (
                    <li key={row.paymentId}>
                      <Card className="flex flex-col gap-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-base font-semibold text-neutral-900">{money(row.amount)}</span>
                          <Badge variant={state.variant}>{state.label}</Badge>
                        </div>
                        <span className="text-sm text-neutral-600">
                          {statusLabel(row.status)}, {when(row.paidTime ?? row.createTime)}
                        </span>
                        <span className="text-sm text-neutral-600">
                          {formatNumber(row.statementCount)} laporan, total {money(row.statementsTotal)}
                        </span>
                        {row.bankAccountLast4 && <span className="text-sm text-neutral-600">Rekening berakhiran {row.bankAccountLast4}</span>}
                      </Card>
                    </li>
                  );
                })}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>Waktu</Th>
                  <Th>Jumlah</Th>
                  <Th>Status</Th>
                  <Th>Rekening</Th>
                  <Th>Laporan terkait</Th>
                  <Th>Pemeriksaan</Th>
                </TableHead>
                <tbody>
                  {data.payouts.map((row) => {
                    const state = payoutState(row);
                    return (
                      <Tr key={row.paymentId}>
                        <Td className="text-sm text-neutral-700">{when(row.paidTime ?? row.createTime)}</Td>
                        <Td className="text-sm text-neutral-900">{money(row.amount)}</Td>
                        <Td className="text-sm text-neutral-700">{statusLabel(row.status)}</Td>
                        <Td className="text-sm text-neutral-700">{row.bankAccountLast4 ? `Berakhiran ${row.bankAccountLast4}` : "Tidak ada"}</Td>
                        <Td className="text-sm text-neutral-700">
                          {formatNumber(row.statementCount)}, total {money(row.statementsTotal)}
                        </Td>
                        <Td>
                          <Badge variant={state.variant}>{state.label}</Badge>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </TableContainer>
            </>
          )}
        </Section>

        <Section
          id="tiktok-adjustments-heading"
          title="Jenis penyesuaian"
          description="Transaksi selain pesanan dan pengembalian dana, dengan nama jenis dari TikTok. Akuntan memetakan setiap jenis ke akun di Pemetaan Akun."
          testId="tiktok-adjustment-types"
        >
          {data.adjustmentTypes.length === 0 ? (
            <EmptyState title="Belum ada penyesuaian" description="Penyesuaian muncul di sini saat ada di laporan penyelesaian." />
          ) : (
            <>
              <CardList>
                {data.adjustmentTypes.map((row) => (
                  <li key={row.type}>
                    <Card className="flex flex-col gap-1">
                      <span className="font-mono text-base font-semibold break-all text-neutral-900">{row.type}</span>
                      <span className="text-sm text-neutral-600">
                        {formatNumber(row.count)} transaksi, total {money(row.total)}
                      </span>
                    </Card>
                  </li>
                ))}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>Jenis dari TikTok</Th>
                  <Th>Transaksi</Th>
                  <Th>Total</Th>
                </TableHead>
                <tbody>
                  {data.adjustmentTypes.map((row) => (
                    <Tr key={row.type}>
                      <Td className="font-mono text-sm text-neutral-900">{row.type}</Td>
                      <Td className="text-sm text-neutral-700">{formatNumber(row.count)}</Td>
                      <Td className="text-sm text-neutral-700">{money(row.total)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableContainer>
            </>
          )}
        </Section>
      </div>
    </>
  );
}

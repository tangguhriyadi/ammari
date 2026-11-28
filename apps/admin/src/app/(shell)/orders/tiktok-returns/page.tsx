import Link from "next/link";
import { Badge, Breadcrumb, Card, CardList, EmptyState, PageHeader, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { ReceiveReturnButton } from "@/components/orders/receive-return-button";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { RESPONSE_URGENT_MS, formatResponseDeadline, tiktokNeedsPersonLabel, tiktokRequestKindLabel, tiktokRequestStatusLabel } from "@/lib/orders/tiktok-return-labels";
import { getTikTokReturnsOverview, type TikTokRequestRow } from "@/lib/orders/tiktok-returns";

// Retur dan pembatalan TikTok (docs/plans/tiktok-shop-integration.md §4.5, T6), orders.view on the
// server; "Retur diterima" needs orders.manage (shown only then, checked again by the action).
//   1. Perlu direspons di Seller Center: open requests, soonest deadline first. Phase 1 never answers
//      through the API (Q15); TikTok approves on its own after 48 h.
//   2. Paket dalam perjalanan kembali: stock comes back only when the parcel is here (Q11, Q18).
//   3. Perlu dicek: partial returns and anything the rules could not classify.

export const dynamic = "force-dynamic";

function OrderLink({ row }: { row: Pick<TikTokRequestRow, "orderId" | "orderNo" | "tiktokOrderId"> }) {
  if (row.orderId && row.orderNo) {
    return (
      <Link href={`/orders/${row.orderId}`} className="font-medium text-neutral-900 underline underline-offset-4">
        {row.orderNo}
      </Link>
    );
  }
  return <span className="font-medium text-neutral-900">TikTok {row.tiktokOrderId}</span>;
}

function Deadline({ due, now }: { due: Date; now: Date }) {
  const urgent = due.getTime() - now.getTime() < RESPONSE_URGENT_MS;
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="tiktok-response-deadline">
      <span className="tabular-nums">Sebelum {formatResponseDeadline(due)}</span>
      {urgent && <Badge variant="danger">Segera</Badge>}
    </span>
  );
}

export default async function TikTokReturnsPage() {
  const session = await requirePermission("orders.view");
  const canManage = session.permissionKeys.includes("orders.manage");
  const now = new Date();
  const { responseDue, inTransit, needsPerson } = await getTikTokReturnsOverview(now);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/orders"), { label: "Retur dan pembatalan TikTok" }]} />
      <PageHeader title="Retur dan pembatalan TikTok" description="Permintaan pembeli dari TikTok Shop yang perlu dijawab, paket yang sedang kembali, dan yang perlu dicek." />
      <div className="flex flex-col gap-8">
        <section aria-labelledby="tiktok-response-due-heading" className="flex flex-col gap-3" data-testid="tiktok-response-due">
          <h2 id="tiktok-response-due-heading" className="text-lg font-semibold text-neutral-900">
            Perlu direspons di Seller Center ({formatNumber(responseDue.length)})
          </h2>
          <p className="text-sm text-neutral-600">Jawab di Seller Center TikTok sebelum batas waktunya. Kalau lewat, TikTok menyetujui permintaan secara otomatis.</p>
          {responseDue.length === 0 ? (
            <EmptyState title="Tidak ada permintaan yang perlu dijawab" description="Permintaan pembatalan atau retur baru dari TikTok muncul di sini." />
          ) : (
            <>
              <CardList>
                {responseDue.map((row) => (
                  <li key={`${row.kind}:${row.requestId}`}>
                    <Card className="flex flex-col gap-1">
                      <div className="flex items-start justify-between gap-2">
                        <OrderLink row={row} />
                        <Badge variant="warning">{tiktokRequestKindLabel(row.kind, row.requestType)}</Badge>
                      </div>
                      <span className="text-sm text-neutral-700">{tiktokRequestStatusLabel(row.status)}</span>
                      <span className="text-sm text-neutral-900">
                        <Deadline due={row.responseDueAt!} now={now} />
                      </span>
                    </Card>
                  </li>
                ))}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>Pesanan</Th>
                  <Th>Permintaan</Th>
                  <Th>Status di TikTok</Th>
                  <Th>Batas jawab</Th>
                </TableHead>
                <tbody>
                  {responseDue.map((row) => (
                    <Tr key={`${row.kind}:${row.requestId}`}>
                      <Td>
                        <OrderLink row={row} />
                      </Td>
                      <Td className="text-neutral-700">{tiktokRequestKindLabel(row.kind, row.requestType)}</Td>
                      <Td className="text-neutral-700">{tiktokRequestStatusLabel(row.status)}</Td>
                      <Td>
                        <Deadline due={row.responseDueAt!} now={now} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </TableContainer>
            </>
          )}
        </section>

        <section aria-labelledby="tiktok-in-transit-heading" className="flex flex-col gap-3" data-testid="tiktok-in-transit">
          <h2 id="tiktok-in-transit-heading" className="text-lg font-semibold text-neutral-900">
            Paket dalam perjalanan kembali ({formatNumber(inTransit.length)})
          </h2>
          <p className="text-sm text-neutral-600">Stok belum dikembalikan. Tekan Retur diterima hanya setelah paketnya sampai di toko. Yang paling lama ada di atas; paket yang tidak pernah kembali dicatat pemilik sebagai penyesuaian stok.</p>
          {inTransit.length === 0 ? (
            <EmptyState title="Tidak ada paket yang sedang kembali" description="Paket yang gagal dikirim atau diretur pembeli muncul di sini." />
          ) : (
            <>
              <CardList>
                {inTransit.map((row) => (
                  <li key={row.orderId}>
                    <Card className="flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/orders/${row.orderId}`} className="font-medium text-neutral-900 underline underline-offset-4">
                          {row.orderNo}
                        </Link>
                        <Badge variant="neutral">{ORDER_STATUS_LABELS[row.status as keyof typeof ORDER_STATUS_LABELS] ?? row.status}</Badge>
                      </div>
                      <span className="text-sm text-neutral-700">Sejak {row.since ? formatDateTime(row.since) : "-"}</span>
                      {canManage && <ReceiveReturnButton orderId={row.orderId} orderNo={row.orderNo} />}
                    </Card>
                  </li>
                ))}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>Pesanan</Th>
                  <Th>Status</Th>
                  <Th>Sejak</Th>
                  <Th>
                    <span className="sr-only">Aksi</span>
                  </Th>
                </TableHead>
                <tbody>
                  {inTransit.map((row) => (
                    <Tr key={row.orderId}>
                      <Td>
                        <Link href={`/orders/${row.orderId}`} className="font-medium text-neutral-900 underline underline-offset-4">
                          {row.orderNo}
                        </Link>
                      </Td>
                      <Td className="text-neutral-700">{ORDER_STATUS_LABELS[row.status as keyof typeof ORDER_STATUS_LABELS] ?? row.status}</Td>
                      <Td className="text-neutral-700 tabular-nums">{row.since ? formatDateTime(row.since) : "-"}</Td>
                      <Td className="text-right">{canManage && <ReceiveReturnButton orderId={row.orderId} orderNo={row.orderNo} />}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableContainer>
            </>
          )}
        </section>

        <section aria-labelledby="tiktok-needs-person-heading" className="flex flex-col gap-3" data-testid="tiktok-needs-person">
          <h2 id="tiktok-needs-person-heading" className="text-lg font-semibold text-neutral-900">
            Perlu dicek ({formatNumber(needsPerson.length)})
          </h2>
          <p className="text-sm text-neutral-600">Permintaan yang tidak bisa diproses otomatis. Cek di Seller Center, lalu catat secara manual. Tidak ada stok atau status yang diubah otomatis.</p>
          {needsPerson.length === 0 ? (
            <EmptyState title="Tidak ada yang perlu dicek" description="Retur sebagian dan permintaan yang tidak dikenali muncul di sini." />
          ) : (
            <>
              <CardList>
                {needsPerson.map((row) => (
                  <li key={`${row.kind}:${row.requestId}`}>
                    <Card className="flex flex-col gap-1">
                      <div className="flex items-start justify-between gap-2">
                        <OrderLink row={row} />
                        <Badge variant="danger">{tiktokNeedsPersonLabel(row.state, row.reviewReason)}</Badge>
                      </div>
                      <span className="text-sm text-neutral-700">
                        {tiktokRequestKindLabel(row.kind, row.requestType)}, {tiktokRequestStatusLabel(row.status)}
                      </span>
                    </Card>
                  </li>
                ))}
              </CardList>
              <TableContainer>
                <TableHead>
                  <Th>Pesanan</Th>
                  <Th>Permintaan</Th>
                  <Th>Status di TikTok</Th>
                  <Th>Alasan</Th>
                </TableHead>
                <tbody>
                  {needsPerson.map((row) => (
                    <Tr key={`${row.kind}:${row.requestId}`}>
                      <Td>
                        <OrderLink row={row} />
                      </Td>
                      <Td className="text-neutral-700">{tiktokRequestKindLabel(row.kind, row.requestType)}</Td>
                      <Td className="text-neutral-700">{tiktokRequestStatusLabel(row.status)}</Td>
                      <Td>
                        <Badge variant="danger">{tiktokNeedsPersonLabel(row.state, row.reviewReason)}</Badge>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </TableContainer>
            </>
          )}
        </section>
      </div>
    </>
  );
}

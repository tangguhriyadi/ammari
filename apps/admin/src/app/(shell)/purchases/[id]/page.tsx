import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader, Badge, Breadcrumb, Button, Card, CardList, TableContainer, TableHead, Th, Tr, Td } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { StaffSessionData } from "@ammari/auth/staff";
import { requirePermission } from "@/lib/auth/require-permission";
import { getPurchaseById, stripPurchaseAmount, type PurchaseDetail } from "@/lib/inventory/purchases";
import { formatPurchaseQty, getPurchaseDocument, isUuid, stripPurchaseDocumentAmounts, type PurchaseDocument } from "@/lib/purchases/queries";
import { isOpenPurchaseStatus, TERMINAL_PURCHASE_STATUSES } from "@/lib/purchases/status";
import {
  findPurchaseIdForReceiptMovement,
  getSellableReceiptValueForPurchase,
  listReceiptsForPurchase,
  type PurchaseReceiptRow,
} from "@/lib/receipts/queries";
import { getDefectBalance, listDefectMovementsForPurchase, stripDefectMovementAmounts, type DefectBalance } from "@/lib/defects/queries";
import { purchaseVariance, summarizeDefectValues, type PurchaseVariance } from "@/lib/defects/variance";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ClosePurchaseButton } from "../_components/close-purchase-button";
import { DefectHistory } from "../_components/defect-history";
import { DisposeDefectsButton, ReturnDefectsButton } from "../_components/defect-actions";
import { PurchaseVariancePanel } from "../_components/defect-variance";
import { PurchaseStatusBadge } from "../_components/purchase-status-badge";
import { ReverseReceiptButton } from "../_components/reverse-receipt-button";
import { VoidPurchaseButton } from "../_components/void-purchase-button";

/** One route, three kinds of id: a purchase DOCUMENT (the normal case); a LEGACY single-row
 * purchase movement (D11, linked from /purchases/legacy and the stock ledgers); or a ledger row a
 * goods receipt wrote (the stock ledgers link every 'purchase' row here), which redirects to its
 * document. */
export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const document = await getPurchaseDocument(id);
  if (document) return <PurchaseDocumentView document={document} session={session} />;

  const legacy = await getPurchaseById(id);
  if (legacy) return <LegacyPurchaseView purchaseRaw={legacy} session={session} />;

  const documentId = await findPurchaseIdForReceiptMovement(id);
  if (documentId) redirect(`/purchases/${documentId}`);
  notFound();
}

async function PurchaseDocumentView({ document: documentRaw, session }: { document: PurchaseDocument; session: StaffSessionData }) {
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");
  const canReceive = session.permissionKeys.includes("inventory.receive");
  const document = stripPurchaseDocumentAmounts(documentRaw, canViewProfit);
  const [receipts, defectRowsRaw] = await Promise.all([listReceiptsForPurchase(document.id), listDefectMovementsForPurchase(document.id)]);
  const defectRows = stripDefectMovementAmounts(defectRowsRaw, canViewProfit);

  const isOpen = isOpenPurchaseStatus(document.status);
  // Open but fully settled (some of it as defects): nothing left to receive, only to close.
  const hasOutstanding = document.lines.some((line) => line.outstanding > 0);
  const canEdit = canManage && canViewProfit && document.status === "ordered" && !document.hasReceipts;
  const nothingArrived = document.lines.every((line) => line.accepted === 0 && line.rejected === 0);
  const isTerminal = TERMINAL_PURCHASE_STATUSES.includes(document.status);
  // Defect actions (inventory.manage, D10) on every line still holding defect stock.
  const actionableLines = canManage ? document.lines.filter((line) => line.defectHeld > 0) : [];
  // Cost data: queried only for finance.view_profit (the disposal preview and the §4.3 panel).
  const [pools, variance] = canViewProfit
    ? await Promise.all([
        Promise.all(
          actionableLines.map(async (line) => [
            line.id,
            await getDefectBalance(line.itemType === "fabric" ? { kind: "fabric", fabricId: line.itemId } : { kind: "accessory", accessoryId: line.itemId }),
          ] as const),
        ).then((entries) => new Map<string, DefectBalance>(entries)),
        getSellableReceiptValueForPurchase(document.id).then((sellableValue): PurchaseVariance | null => {
          const defects = summarizeDefectValues(defectRowsRaw);
          return defects
            ? purchaseVariance({
                totalOrdered: document.lines.reduce((sum, line) => sum + (line.totalAmountPaid ?? 0), 0),
                sellableValue,
                closed: isTerminal,
                defects,
              })
            : null;
        }),
      ])
    : [new Map<string, DefectBalance>(), null];

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: document.purchaseNo }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader title={document.purchaseNo} description={`Pesanan pembelian · ${formatDate(new Date(document.orderedAt))}`} />
        <div className="flex flex-wrap justify-end gap-2">
          {document.reopenedAt && <Badge variant="neutral">Dibuka kembali</Badge>}
          <PurchaseStatusBadge status={document.status} />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
        <Row
          label="Supplier"
          value={
            <Link href={`/suppliers/${document.supplierId}`} className="font-medium text-brand hover:underline">
              {document.supplierName}
            </Link>
          }
        />
        {document.notes && <Row label="Catatan" value={document.notes} />}
        <Row label="Dibuat" value={`${formatDateTime(document.createdAt)}${document.createdByName ? ` · ${document.createdByName}` : ""}`} />
        {document.closedAt && (
          <>
            <Row
              label={document.status === "cancelled" ? "Dibatalkan" : "Ditutup"}
              value={`${formatDateTime(document.closedAt)}${document.closedByName ? ` · ${document.closedByName}` : ""}`}
            />
            {document.closeReason && <Row label="Alasan" value={document.closeReason} />}
          </>
        )}
        {document.reopenedAt && (
          <>
            <Row
              label="Dibuka kembali"
              value={`${formatDateTime(document.reopenedAt)}${document.reopenedByName ? ` · ${document.reopenedByName}` : ""}`}
            />
            {document.reopenReason && <Row label="Alasan dibuka" value={document.reopenReason} />}
          </>
        )}
      </div>

      {variance && (
        <div className="mt-4">
          <PurchaseVariancePanel variance={variance} />
        </div>
      )}

      {(isOpen && (canReceive || canManage)) || canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {isOpen && canReceive && hasOutstanding && (
            <Link href={`/purchases/${document.id}/receive`}>
              <Button>Terima barang</Button>
            </Link>
          )}
          {canEdit && (
            <Link href={`/purchases/${document.id}/edit`}>
              <Button variant="secondary">Ubah pesanan</Button>
            </Link>
          )}
          {isOpen && canManage && <ClosePurchaseButton purchaseId={document.id} nothingArrived={nothingArrived} />}
        </div>
      ) : null}

      {isOpen && !hasOutstanding && (
        <p className="mt-4 text-base text-neutral-700">
          Semua sisa sudah diterima atau dicatat cacat. Barang cacat bisa dikembalikan ke supplier untuk ditukar atau dilepas. Tutup pesanan jika tidak ada lagi yang ditunggu.
        </p>
      )}

      <h2 className="mt-6 mb-3 text-lg font-semibold text-neutral-900">Barang</h2>
      <PurchaseLines
        document={document}
        actions={
          canManage
            ? (line) =>
                line.defectHeld > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    <ReturnDefectsButton
                      sourceType="purchase"
                      lineId={line.id}
                      itemLabel={line.itemName}
                      maxQty={line.defectHeld}
                      isFabric={line.itemType === "fabric"}
                      documentClosed={isTerminal}
                    />
                    <DisposeDefectsButton
                      sourceType="purchase"
                      lineId={line.id}
                      itemLabel={line.itemName}
                      maxQty={line.defectHeld}
                      isFabric={line.itemType === "fabric"}
                      pool={pools.get(line.id) ?? null}
                    />
                  </div>
                ) : null
            : undefined
        }
      />

      <h2 className="mt-6 mb-3 text-lg font-semibold text-neutral-900">Riwayat penerimaan</h2>
      <ReceiptHistory receipts={receipts} canReverse={canManage} />

      <h2 className="mt-6 mb-3 text-lg font-semibold text-neutral-900">Barang cacat</h2>
      <DefectHistory rows={defectRows} emptyText="Tidak ada barang cacat dari pesanan ini." canReverse={canManage} />
    </>
  );
}

type PurchaseLine = PurchaseDocument["lines"][number];

/** Dipesan / Diterima / Cacat / Ditukar / Dilepas / Sisa (§7). "Cacat" is what is STILL held in
 * defect stock from the line (it shrinks after a return or a release); together with Ditukar and
 * Dilepas it adds up to everything that ever arrived defective. */
function PurchaseLines({ document, actions }: { document: PurchaseDocument; actions?: (line: PurchaseLine) => ReactNode }) {
  const showTotals = document.lines.some((line) => line.totalAmountPaid !== null);
  const showActions = actions !== undefined && document.lines.some((line) => line.defectHeld > 0);
  const hasDefects = document.lines.some((line) => line.rejected !== 0);
  return (
    <>
      <CardList>
        {document.lines.map((line) => (
          <li key={line.id} data-testid="purchase-line-card">
            <Card className="flex flex-col gap-2">
              <p className="text-base font-medium text-neutral-900">{line.itemName}</p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <QtyCell label="Dipesan" value={formatPurchaseQty(line.itemType, line.qtyOrdered)} />
                <QtyCell label="Diterima" value={formatPurchaseQty(line.itemType, line.accepted)} />
                <QtyCell label="Cacat" value={formatPurchaseQty(line.itemType, line.defectHeld)} />
                <QtyCell label="Ditukar" value={formatPurchaseQty(line.itemType, line.returned)} />
                <QtyCell label="Dilepas" value={formatPurchaseQty(line.itemType, line.released)} />
                <QtyCell label="Sisa" value={formatPurchaseQty(line.itemType, line.outstanding)} />
              </dl>
              {line.totalAmountPaid !== null && <p className="text-sm text-neutral-600">Total dibayar {formatRupiah(line.totalAmountPaid)}</p>}
              {actions?.(line)}
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Barang</Th>
          <Th>Dipesan</Th>
          <Th>Diterima</Th>
          <Th>Cacat</Th>
          <Th>Ditukar</Th>
          <Th>Dilepas</Th>
          <Th>Sisa</Th>
          {showTotals && <Th>Total dibayar</Th>}
          {showActions && <Th>Barang cacat</Th>}
        </TableHead>
        <tbody>
          {document.lines.map((line) => (
            <Tr key={line.id} data-testid="purchase-line-row">
              <Td className="font-medium text-neutral-900">{line.itemName}</Td>
              <Td className="tabular-nums text-neutral-700">{formatPurchaseQty(line.itemType, line.qtyOrdered)}</Td>
              <Td className="tabular-nums text-neutral-700">{formatPurchaseQty(line.itemType, line.accepted)}</Td>
              <Td className="tabular-nums text-neutral-700">{formatPurchaseQty(line.itemType, line.defectHeld)}</Td>
              <Td className="tabular-nums text-neutral-700">{formatPurchaseQty(line.itemType, line.returned)}</Td>
              <Td className="tabular-nums text-neutral-700">{formatPurchaseQty(line.itemType, line.released)}</Td>
              <Td className="tabular-nums text-neutral-700">{formatPurchaseQty(line.itemType, line.outstanding)}</Td>
              {showTotals && <Td className="tabular-nums text-neutral-700">{line.totalAmountPaid !== null ? formatRupiah(line.totalAmountPaid) : "-"}</Td>}
              {showActions && <Td>{actions?.(line)}</Td>}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
      {hasDefects && (
        <p className="mt-2 text-sm text-neutral-600">
          Cacat: stok cacat yang masih disimpan. Ditukar: dikembalikan ke supplier untuk diganti. Dilepas: dilelang, dihibahkan, atau dibuang.
        </p>
      )}
    </>
  );
}

function QtyCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-neutral-600">{label}</dt>
      <dd className="tabular-nums text-neutral-900">{value}</dd>
    </div>
  );
}

function ReceiptHistory({ receipts, canReverse }: { receipts: PurchaseReceiptRow[]; canReverse: boolean }) {
  if (receipts.length === 0) return <p className="text-base text-neutral-600">Belum ada barang yang diterima.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {receipts.map((receipt) => (
        <li key={receipt.id} data-testid="receipt-row">
          <Card className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-base font-medium text-neutral-900">
                {receipt.receiptNo}
                {receipt.kind === "reversal" && <span className="ml-2 text-sm font-normal text-neutral-600">Pembatalan {receipt.reversesReceiptNo}</span>}
              </p>
              {receipt.reversedAt !== null && <Badge variant="neutral">Dibatalkan</Badge>}
            </div>
            <p className="text-sm text-neutral-600">
              Diterima {formatDate(new Date(receipt.receivedAt))}
              {receipt.receivedByName ? ` oleh ${receipt.receivedByName}` : ""}
              {" · "}dicatat {formatDateTime(receipt.createdAt)}
              {receipt.createdByName ? ` oleh ${receipt.createdByName}` : ""}
            </p>
            <ul className="text-sm text-neutral-800">
              {receipt.items.map((item) => (
                <li key={item.purchaseItemId}>
                  {item.itemName}: {formatPurchaseQty(item.itemType, item.qtyAccepted)}
                  {item.qtyRejected !== 0 && <> · ditolak (cacat) {formatPurchaseQty(item.itemType, item.qtyRejected)}</>}
                </li>
              ))}
            </ul>
            {receipt.note && receipt.kind === "receipt" && <p className="text-sm text-neutral-600">{receipt.note}</p>}
            {canReverse && receipt.kind === "receipt" && receipt.reversedAt === null && (
              <div>
                <ReverseReceiptButton receiptId={receipt.id} receiptNo={receipt.receiptNo} />
              </div>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}

const ITEM_TYPE_LABELS = { fabric: "Kain", accessory: "Aksesoris" } as const;
const ITEM_MASTER_PATH = { fabric: "/fabrics", accessory: "/accessories" } as const;

/** A legacy single-row purchase (D11), displayed exactly as before purchase documents existed. */
function LegacyPurchaseView({ purchaseRaw, session }: { purchaseRaw: PurchaseDetail; session: StaffSessionData }) {
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");
  const purchase = stripPurchaseAmount(purchaseRaw, canViewProfit);

  // /fabrics/[id] is gated by products.manage — a different permission domain from this page's
  // own inventory.view — so an accessory purchase's master link is always reachable (accessories
  // are gated by inventory.view too) but a fabric purchase's is not. See stock/fabrics/[id]'s
  // matching comment.
  const canViewMaster = purchase.itemType === "accessory" || session.permissionKeys.includes("products.manage");

  const unitLabel = purchase.itemType === "fabric" ? "yard" : "pcs";
  const qtyLabel = purchase.itemType === "fabric" ? purchase.qty.toFixed(2) : String(purchase.qty);
  const unitPrice = purchase.totalAmountPaid !== null && purchase.qty > 0 ? Math.round(purchase.totalAmountPaid / purchase.qty) : null;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: "Pembelian lama", href: "/purchases/legacy" }, { label: purchase.itemName }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader title={purchase.itemName} description={`Pembelian lama ${ITEM_TYPE_LABELS[purchase.itemType]} · ${formatDate(new Date(purchase.purchasedAt))}`} />
        {purchase.voidedAt !== null && <Badge variant="neutral">Dibatalkan</Badge>}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
        <Row label="Jumlah" value={`${qtyLabel} ${unitLabel}`} />
        {purchase.totalAmountPaid !== null && <Row label="Total dibayar" value={formatRupiah(purchase.totalAmountPaid)} />}
        {unitPrice !== null && <Row label="Harga satuan" value={`≈ ${formatRupiah(unitPrice)}/${unitLabel} (otomatis)`} />}
        <Row label="Supplier" value={purchase.supplier ?? "-"} />
        {purchase.note && <Row label="Catatan" value={purchase.note} />}
        <Row label="Dicatat" value={`${formatDateTime(purchase.createdAt)}${purchase.createdByName ? ` · ${purchase.createdByName}` : ""}`} />
      </div>
      {canViewMaster && (
        <p className="mt-3">
          <Link href={`${ITEM_MASTER_PATH[purchase.itemType]}/${purchase.itemId}`} className="text-base font-medium text-brand hover:underline">
            Lihat data master →
          </Link>
        </p>
      )}
      {canManage && purchase.voidedAt === null && (
        <div className="mt-6">
          <VoidPurchaseButton type={purchase.itemType} movementId={purchase.id} />
        </div>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <span className="text-right text-base text-neutral-900">{value}</span>
    </div>
  );
}

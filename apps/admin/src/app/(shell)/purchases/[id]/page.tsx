import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Badge, Breadcrumb } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getPurchaseById, stripPurchaseAmount } from "@/lib/inventory/purchases";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { VoidPurchaseButton } from "../_components/void-purchase-button";

const ITEM_TYPE_LABELS = { fabric: "Kain", accessory: "Aksesoris" } as const;
const ITEM_MASTER_PATH = { fabric: "/fabrics", accessory: "/accessories" } as const;

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;

  const purchaseRaw = await getPurchaseById(id);
  if (!purchaseRaw) notFound();

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
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: purchase.itemName }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader title={purchase.itemName} description={`Pembelian ${ITEM_TYPE_LABELS[purchase.itemType]} · ${formatDate(new Date(purchase.purchasedAt))}`} />
        {purchase.voidedAt !== null && <Badge variant="neutral">Dibatalkan</Badge>}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
        <Row label="Jumlah" value={`${qtyLabel} ${unitLabel}`} />
        {purchase.totalAmountPaid !== null && <Row label="Total dibayar" value={formatRupiah(purchase.totalAmountPaid)} />}
        {unitPrice !== null && <Row label="Harga satuan" value={`≈ ${formatRupiah(unitPrice)}/${unitLabel} (otomatis)`} />}
        <Row label="Pemasok" value={purchase.supplier ?? "—"} />
        {purchase.note && <Row label="Catatan" value={purchase.note} />}
        <Row
          label="Dicatat"
          value={`${formatDateTime(purchase.createdAt)}${purchase.createdByName ? ` · ${purchase.createdByName}` : ""}`}
        />
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <span className="text-base text-neutral-900">{value}</span>
    </div>
  );
}

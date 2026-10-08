import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Badge, Button, Breadcrumb } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getAccessoryBalance, getAccessoryById } from "@/lib/inventory/accessories";
import { rootCrumbs } from "@/lib/nav/breadcrumb";

export default async function AccessoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;

  const accessory = await getAccessoryById(id);
  if (!accessory) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const balance = await getAccessoryBalance(id);
  const avgCost = canViewProfit && balance.qty > 0 ? Math.round(balance.valueAmount / balance.qty) : null;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accessories"), { label: accessory.name }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader
          title={accessory.name}
          description={[accessory.size === "ALLSIZE" ? "Polos" : accessory.size, accessory.sizeGroup].filter(Boolean).join(" · ") || undefined}
          actions={
            canManage ? (
              <Link href={`/accessories/${id}/edit`}>
                <Button variant="secondary">Edit</Button>
              </Link>
            ) : undefined
          }
        />
        {!accessory.isActive && <Badge variant="neutral">Nonaktif</Badge>}
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="text-2xl font-semibold tabular-nums text-neutral-900">{formatNumber(balance.qty)} pcs</span>
        {avgCost !== null && <span className="text-base text-neutral-600 tabular-nums">≈ {formatRupiah(avgCost)}/pcs</span>}
        <Link href={`/stock/accessories/${id}`} className="text-base font-medium text-brand hover:underline">
          Lihat riwayat stok →
        </Link>
      </div>
    </>
  );
}

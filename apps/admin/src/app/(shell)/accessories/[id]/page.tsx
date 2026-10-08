import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Badge, Button } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getAccessoryBalance, getAccessoryById, listAccessoryLedger } from "@/lib/inventory/accessories";
import { AccessoryLedger } from "../_components/accessory-ledger";
import { AccessoryDetailControls } from "../_components/accessory-detail-controls";

export default async function AccessoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;
  const { page } = await searchParams;

  const accessory = await getAccessoryById(id);
  if (!accessory) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const balance = await getAccessoryBalance(id);
  const { rows, pagination } = await listAccessoryLedger(id, page);

  return (
    <>
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
        {canManage && <AccessoryDetailControls accessoryId={accessory.id} />}
      </div>
      <AccessoryLedger
        rows={rows}
        pagination={pagination}
        basePath={`/accessories/${id}`}
        canViewProfit={canViewProfit}
        canManage={canManage}
      />
    </>
  );
}

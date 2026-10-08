import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getFabricById } from "@/lib/products/fabric-queries";
import { getFabricBalance, listFabricStockLedger } from "@/lib/inventory/fabric-stock";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FabricLedger } from "../../_components/fabric-ledger";
import { FabricStockControls } from "../../_components/fabric-stock-controls";

export default async function FabricStockDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;
  const { page, perPage } = await searchParams;

  const fabric = await getFabricById(id);
  if (!fabric) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");
  // /fabrics/[id] is gated by products.manage, a different permission domain from this page's
  // own inventory.view — see the matching comment where fabrics/[id] itself checks inventory.view
  // before linking to THIS page. Linking there unconditionally would dangle for a session that
  // holds inventory.view/inventory.manage but not products.manage.
  const canViewMaster = session.permissionKeys.includes("products.manage");

  const [balance, { rows, pagination }] = await Promise.all([getFabricBalance(id), listFabricStockLedger(id, page, perPage)]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Kain", href: "/stock/fabrics" }, { label: fabric.name }]} />
      <PageHeader title={fabric.name} description={fabric.supplier ?? undefined} />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="text-2xl font-semibold tabular-nums text-neutral-900">{balance.qty.toFixed(2)} yard</span>
        {canManage && <FabricStockControls fabricId={fabric.id} />}
        {canViewMaster && (
          <Link href={`/fabrics/${id}`} className="text-base font-medium text-brand hover:underline">
            Lihat data master →
          </Link>
        )}
      </div>
      <FabricLedger
        rows={rows}
        pagination={pagination}
        basePath={`/stock/fabrics/${id}`}
        searchParams={{ perPage }}
        canViewProfit={canViewProfit}
      />
    </>
  );
}

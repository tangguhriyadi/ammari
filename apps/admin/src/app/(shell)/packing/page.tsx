import { Breadcrumb, FilterTabs, Pagination, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listChannels } from "@/lib/orders/queries";
import { listPackingQueue } from "@/lib/packing/queries";
import { resolvePackingChannelFilter } from "@/lib/packing/channel-filter";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PackingList } from "./_components/packing-list";

export default async function PackingPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("packing.print_cards");
  const { channel: rawChannel, page, perPage } = await searchParams;

  const channels = await listChannels();
  const channelId = resolvePackingChannelFilter(rawChannel, channels);

  const { rows, items, pagination } = await listPackingQueue({ channelId }, page, perPage);

  const canShip = session.permissionKeys.includes("orders.manage");

  return (
    <>
      <Breadcrumb items={rootCrumbs("/packing")} />
      <PageHeader title="Packing" description="Antrean packing dan cetak kartu terima kasih." />
      <div className="flex flex-col gap-3">
        <FilterTabs
          basePath="/packing"
          paramName="channel"
          options={[{ label: "Semua", value: undefined }, ...channels.map((c) => ({ label: c.name, value: c.id }))]}
          activeValue={channelId}
          aria-label="Filter kanal"
        />
        <PackingList
          rows={rows}
          items={Object.fromEntries(items)}
          canShip={canShip}
        />
      </div>
      <Pagination pagination={pagination} basePath="/packing" searchParams={{ channel: rawChannel, perPage }} itemLabel="pesanan" />
    </>
  );
}

import Link from "next/link";
import { Breadcrumb, Button, Input, Label, PageHeader, Pagination, Select } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ACTIVITY_AREAS, type ActivityArea } from "@/lib/activity-log/catalog";
import { NON_STAFF_ACTOR_FILTER, filterSearchParams, isDefaultFilters, parseActivityLogFilters, toQueryString } from "@/lib/activity-log/filters";
import { listActivityLog, listActorOptions } from "@/lib/activity-log/queries";
import { ActivityList } from "./_components/activity-list";

// Log Aktivitas (docs/plans/activity-log.md): read-only, newest first. No edit or delete exists
// anywhere for audit_log. Every filter lives in the URL (a plain GET form), so a filtered view
// can be bookmarked or shared and the CSV link reuses it.

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; actor?: string; area?: string; q?: string; page?: string; perPage?: string }>;
}) {
  await requirePermission("audit_log.view");
  const raw = await searchParams;
  const today = jakartaDate();
  const filters = parseActivityLogFilters(raw, today);
  const params = filterSearchParams(filters);

  const [{ rows, pagination, searchTruncated }, actorOptions] = await Promise.all([listActivityLog(filters, raw.page, raw.perPage), listActorOptions()]);
  const isDefault = isDefaultFilters(filters, today);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/activity-log")} />
      <PageHeader
        title="Log Aktivitas"
        description="Siapa mengubah apa dan kapan, terbaru di atas. Waktu dalam WIB."
        actions={
          // A plain <a download>, not <Link>: Link would prefetch this route handler, and every
          // request to it writes an audit row.
          <a
            href={`/activity-log/export${toQueryString(params)}`}
            download
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-neutral-500 bg-white px-4 text-base font-medium text-neutral-700 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            Unduh CSV
          </a>
        }
      />
      <form method="GET" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" aria-label="Filter log aktivitas">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="activity-from">Dari tanggal</Label>
          <Input id="activity-from" name="from" type="date" defaultValue={filters.from} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="activity-to">Sampai tanggal</Label>
          <Input id="activity-to" name="to" type="date" defaultValue={filters.to} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="activity-actor">Pelaku</Label>
          <Select id="activity-actor" name="actor" defaultValue={filters.actor ?? ""}>
            <option value="">Semua</option>
            <option value={NON_STAFF_ACTOR_FILTER}>Sistem atau pembeli</option>
            {actorOptions.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.isActive ? actor.name : `${actor.name} (nonaktif)`}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="activity-area">Bagian</Label>
          <Select id="activity-area" name="area" defaultValue={filters.area ?? ""}>
            <option value="">Semua</option>
            {(Object.entries(ACTIVITY_AREAS) as [ActivityArea, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="activity-q">Cari data</Label>
          <Input id="activity-q" name="q" defaultValue={filters.q ?? ""} placeholder="No. pesanan, produk, BYR-..." />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit">Terapkan</Button>
          {!isDefault && (
            <Link href="/activity-log" className="text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          )}
        </div>
      </form>
      {searchTruncated && (
        <p role="status" className="mb-3 text-sm text-neutral-600">
          Kata pencarian cocok dengan terlalu banyak data, jadi hanya sebagian yang dicari. Pakai kata yang lebih spesifik, misalnya nomor pesanan lengkap.
        </p>
      )}
      <ActivityList rows={rows} filtered={!isDefault} />
      <Pagination pagination={pagination} basePath="/activity-log" searchParams={{ ...params, perPage: raw.perPage }} itemLabel="aktivitas" />
    </>
  );
}

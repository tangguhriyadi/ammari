import Link from "next/link";
import { PageHeader, Button, Input, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricsWithUsage } from "@/lib/products/fabric-queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FabricList } from "./_components/fabric-list";

export default async function BahanPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; perPage?: string }>;
}) {
  await requirePermission("products.manage");
  const { q, page, perPage } = await searchParams;
  const { rows, pagination } = await listFabricsWithUsage(q, page, perPage);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/fabrics")} />
      <PageHeader
        title="Bahan"
        description="Kain yang dipakai untuk membuat produk."
        actions={
          <Link href="/fabrics/new">
            <Button>Tambah bahan</Button>
          </Link>
        }
      />
      <div className="flex flex-col gap-3">
        <form method="GET">
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama bahan..." aria-label="Cari bahan" />
        </form>
        <FabricList fabrics={rows} />
      </div>
      <Pagination pagination={pagination} basePath="/fabrics" searchParams={{ q, perPage }} itemLabel="bahan" />
    </>
  );
}

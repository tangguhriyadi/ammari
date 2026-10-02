import Link from "next/link";
import { PageHeader, Button, Input, Pagination } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricsWithUsage } from "@/lib/products/fabric-queries";
import { FabricList } from "./_components/fabric-list";

export default async function BahanPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requirePermission("products.manage");
  const { q, page } = await searchParams;
  const { rows, pagination } = await listFabricsWithUsage(q, page);

  return (
    <>
      <PageHeader
        title="Bahan"
        description="Kain yang dipakai untuk membuat produk."
        actions={
          <Link href="/bahan/baru">
            <Button>Tambah bahan</Button>
          </Link>
        }
      />
      <form className="mb-4" method="GET">
        <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama bahan..." aria-label="Cari bahan" />
      </form>
      <FabricList fabrics={rows} />
      <Pagination pagination={pagination} basePath="/bahan" searchParams={{ q }} itemLabel="bahan" />
    </>
  );
}

import Link from "next/link";
import { PageHeader, Button, Input, Pagination } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listProducts } from "@/lib/products/queries";
import { ProductList } from "./_components/product-list";

export default async function ProdukPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requirePermission("products.manage");
  const { q, page } = await searchParams;
  const { rows, pagination } = await listProducts(q, page);

  return (
    <>
      <PageHeader
        title="Produk"
        description="Produk dan variannya."
        actions={
          <Link href="/produk/baru">
            <Button>Tambah produk</Button>
          </Link>
        }
      />
      <form className="mb-4" method="GET">
        <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama produk..." aria-label="Cari produk" />
      </form>
      <ProductList products={rows} />
      <Pagination pagination={pagination} basePath="/produk" searchParams={{ q }} itemLabel="produk" />
    </>
  );
}

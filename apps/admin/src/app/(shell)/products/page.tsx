import Link from "next/link";
import { PageHeader, Button, Input, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listProducts } from "@/lib/products/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductList } from "./_components/product-list";

export default async function ProdukPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; perPage?: string }>;
}) {
  await requirePermission("products.manage");
  const { q, page, perPage } = await searchParams;
  const { rows, pagination } = await listProducts(q, page, perPage);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/products")} />
      <PageHeader
        title="Produk"
        description="Produk dan variannya."
        actions={
          <Link href="/products/new">
            <Button>Tambah produk</Button>
          </Link>
        }
      />
      <div className="flex flex-col gap-3">
        <form method="GET">
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama produk..." aria-label="Cari produk" />
        </form>
        <ProductList products={rows} />
      </div>
      <Pagination pagination={pagination} basePath="/products" searchParams={{ q, perPage }} itemLabel="produk" />
    </>
  );
}

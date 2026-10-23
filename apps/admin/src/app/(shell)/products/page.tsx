import Link from "next/link";
import { PageHeader, Button, Input, Label, Pagination, Breadcrumb, Select } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listProducts } from "@/lib/products/queries";
import { listProductTypeFilterOptions } from "@/lib/product-types/queries";
import { isProductTypeCode } from "@/lib/product-types/codes";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductList } from "./_components/product-list";

export default async function ProdukPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; page?: string; perPage?: string }>;
}) {
  await requirePermission("products.manage");
  const { q, type: rawType, page, perPage } = await searchParams;
  // A malformed `type` is ignored (all types), never sent to the query; an unknown but
  // well-formed one simply matches nothing.
  const productTypeCode = rawType && isProductTypeCode(rawType) ? rawType : undefined;
  const [{ rows, pagination }, typeOptions] = await Promise.all([
    listProducts({ q, productTypeCode }, page, perPage),
    listProductTypeFilterOptions(),
  ]);
  const hasFilters = Boolean(q || productTypeCode);

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
        <form method="GET" className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end" aria-label="Filter produk">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="products-q">Cari</Label>
            <Input id="products-q" name="q" defaultValue={q ?? ""} placeholder="Cari nama produk..." aria-label="Cari produk" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="products-type">Jenis produk</Label>
            <Select id="products-type" name="type" defaultValue={productTypeCode ?? ""}>
              <option value="">Semua jenis</option>
              {typeOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.isActive ? option.name : `${option.name} (nonaktif)`}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit">Terapkan</Button>
            {hasFilters && (
              <Link href="/products" className="text-base font-medium text-brand hover:underline">
                Reset
              </Link>
            )}
          </div>
        </form>
        <ProductList products={rows} />
      </div>
      <Pagination pagination={pagination} basePath="/products" searchParams={{ q, type: productTypeCode, perPage }} itemLabel="produk" />
    </>
  );
}

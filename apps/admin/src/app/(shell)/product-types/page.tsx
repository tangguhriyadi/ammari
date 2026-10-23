import Link from "next/link";
import { Breadcrumb, Button, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listProductTypes } from "@/lib/product-types/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductTypeList } from "./_components/product-type-list";

// docs/plans/product-types.md: the "Jenis Produk" master. Same permission as products.
export default async function ProductTypesPage() {
  await requirePermission("products.manage");
  const rows = await listProductTypes();

  return (
    <>
      <Breadcrumb items={rootCrumbs("/product-types")} />
      <PageHeader
        title="Jenis Produk"
        description="Kelompok produk, mis. Gamis. Jenis yang dinonaktifkan tidak bisa dipilih untuk produk baru, tapi tetap tampil di produk yang sudah memakainya."
        actions={
          <Link href="/product-types/new">
            <Button>Tambah jenis produk</Button>
          </Link>
        }
      />
      <ProductTypeList rows={rows} />
    </>
  );
}

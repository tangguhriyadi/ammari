import Link from "next/link";
import { PageHeader, Button, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listCostComponents } from "@/lib/production/cost-components";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { CostComponentList } from "./_components/cost-component-list";

export default async function CostComponentsPage() {
  await requirePermission("finance.view_profit");
  const components = await listCostComponents();

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/production"), { label: "Komponen Biaya" }]} />
      <PageHeader
        title="Komponen Biaya"
        description="Daftar jenis biaya produksi selain bahan (aksesoris, ongkos jahit, dll)."
        actions={
          <Link href="/production/cost-components/new">
            <Button>Tambah komponen</Button>
          </Link>
        }
      />
      <CostComponentList components={components} />
    </>
  );
}

import Link from "next/link";
import { PageHeader, Button, Breadcrumb, Badge, Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listSizeCharts } from "@/lib/content/size-charts";
import { rootCrumbs } from "@/lib/nav/breadcrumb";

export default async function SizeChartsPage() {
  await requirePermission("content.manage");
  const charts = await listSizeCharts();

  return (
    <>
      <Breadcrumb items={rootCrumbs("/content/size-charts")} />
      <PageHeader
        title="Tabel Ukuran"
        description="Tabel ukuran (Lingkar dada, Panjang gamis, Panjang lengan, Rekomendasi tinggi badan) yang dipakai produk ber-ukuran XS–XL."
        actions={
          <Link href="/content/size-charts/new">
            <Button>Tambah tabel ukuran</Button>
          </Link>
        }
      />

      {charts.length === 0 ? (
        <EmptyState title="Belum ada tabel ukuran" description="Tambah tabel ukuran untuk mulai memakainya di halaman produk." />
      ) : (
        <>
          <CardList>
            {charts.map((chart) => (
              <li key={chart.id}>
                <Link href={`/content/size-charts/${chart.id}`}>
                  <Card className="flex items-center justify-between gap-2">
                    <span className="text-base font-semibold text-neutral-900">{chart.name}</span>
                    {chart.productCount > 0 && <Badge variant="neutral">{chart.productCount} produk</Badge>}
                  </Card>
                </Link>
              </li>
            ))}
          </CardList>

          <TableContainer>
            <TableHead>
              <Th>Nama</Th>
              <Th>Dipakai</Th>
            </TableHead>
            <tbody>
              {charts.map((chart) => (
                <Tr key={chart.id}>
                  <Td>
                    <Link href={`/content/size-charts/${chart.id}`} className="font-medium text-brand hover:underline">
                      {chart.name}
                    </Link>
                  </Td>
                  <Td className="text-neutral-700">{chart.productCount} produk</Td>
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}
    </>
  );
}

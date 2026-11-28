import Link from "next/link";
import { Button, Card } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { SHOPEE_TAB } from "@/lib/integrations/tabs";
import { getLastImportBatch } from "@/lib/marketplace-import/history";

// Administrasi > Integrasi > Shopee: a read-only summary. Shopee has no API connection; its orders
// come in through the file import. Orders a file holds in Perlu dicek are never saved, so there is
// no current held count to show, only what the last saved import counted.

export default async function ShopeeIntegrationPage() {
  const session = await requirePermission(SHOPEE_TAB.permissionKey);
  const last = await getLastImportBatch("shopee");
  const counts = last?.counts;

  return (
    <>
      <div className="flex max-w-3xl flex-col gap-6">
        <Card className="flex flex-col gap-2 p-4 sm:p-6">
          <section aria-labelledby="shopee-last-import-heading" className="flex flex-col gap-2">
            <h2 id="shopee-last-import-heading" className="text-lg font-semibold text-neutral-900">
              Impor pesanan terakhir
            </h2>
            {last ? (
              <>
                <p className="text-sm text-neutral-900">
                  {formatDateTime(last.committedAt)} WIB oleh {last.uploadedByName}
                </p>
                {counts && (
                  <p className="text-sm text-neutral-700">
                    {formatNumber(counts.create + counts.update)} disimpan, {formatNumber(counts.review)} ditahan, {formatNumber(counts.skip)} dilewati
                  </p>
                )}
                <Link href={`/import/${last.id}`} className="inline-flex min-h-11 items-center self-start text-sm font-medium text-brand hover:underline">
                  Lihat rincian impor
                </Link>
              </>
            ) : (
              <p className="text-sm text-neutral-700">Belum ada impor pesanan Shopee yang disimpan.</p>
            )}
          </section>
        </Card>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href="/import">
            <Button className="w-full">Impor file</Button>
          </Link>
          {/* Daftar SKU is gated by stock.view; without it the button would only lead to a 403. */}
          {session.permissionKeys.includes("stock.view") && (
            <Link href="/stock/sku-list">
              <Button variant="secondary" className="w-full">
                Daftar SKU
              </Button>
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

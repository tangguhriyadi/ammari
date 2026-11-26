import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { eligibleAccounts, getMappingPage, type MappingAccountOption, type MappingPage } from "@/lib/accounting/mappings";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { MappingRow, type MappingOption } from "./_components/mapping-row";

// Pemetaan akun (docs/plans/accounting.md Session 3, D-25, D-17, D-18): the account each expense
// category (and optionally item), payment method and sales channel posts to. accounting.view reads;
// accounting.manage edits (every action re-checks). The selects only offer allowed targets: an
// expense never an inventory account 1-15xx (D-14), a method only Kas & Bank, a channel only
// revenue; the server and the database refuse anything else.

/** The allowed accounts for a key, plus its current target if that is no longer offered. */
function optionsFor(mappingKey: string, accountCode: string | null, page: MappingPage): MappingOption[] {
  const options: MappingAccountOption[] = eligibleAccounts(mappingKey, page.accounts);
  if (accountCode && !options.some((option) => option.code === accountCode)) {
    const current = page.accounts.find((account) => account.code === accountCode);
    if (current) options.unshift({ code: current.code, name: current.name, type: current.type });
  }
  return options.map(({ code, name }) => ({ code, name }));
}

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mb-8">
      <h2 id={id} className="text-lg font-semibold text-neutral-900">
        {title}
      </h2>
      <p className="mt-1 text-sm text-neutral-600">{description}</p>
      <ul className="mt-2">{children}</ul>
    </section>
  );
}

export default async function MappingsPage() {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const page = await getMappingPage();
  const unmappedCount = page.categories.filter((category) => category.accountCode === null).length;

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/mappings")} />
      <PageHeader
        title="Pemetaan Akun"
        description="Akun yang dipakai jurnal otomatis untuk setiap kategori biaya, cara bayar dan kanal penjualan. Perubahan berlaku pada posting berikutnya: jurnal yang terkena dibalik lalu dibukukan ulang."
      />
      {unmappedCount > 0 && (
        <p role="status" className="mb-6 rounded-lg border border-warning-700/30 bg-warning-50 p-4 text-base text-warning-700">
          {unmappedCount} kategori biaya belum dipetakan. Biaya di kategori itu belum bisa dibukukan.
        </p>
      )}

      <Section
        id="mapping-categories"
        title="Kategori biaya"
        description="Setiap kategori ke satu akun. Item boleh punya akun sendiri (mis. Biteship Grow ke Beban langganan aplikasi). Kategori untuk membayar utang dipetakan ke akun utangnya. Biaya tidak pernah dipetakan ke akun persediaan."
      >
        {page.categories.map((category) => (
          <Fragment key={category.mappingKey}>
            <MappingRow
              mappingKey={category.mappingKey}
              label={category.label}
              sublabel={category.isActive ? undefined : "Kategori nonaktif"}
              accountCode={category.accountCode}
              options={optionsFor(category.mappingKey, category.accountCode, page)}
              canManage={canManage}
            />
            {category.items.map((item) => (
              <MappingRow
                key={item.mappingKey}
                mappingKey={item.mappingKey}
                label={item.label}
                sublabel={`Item ${category.label}${item.isActive ? "" : ", nonaktif"}`}
                accountCode={item.accountCode}
                options={optionsFor(item.mappingKey, item.accountCode, page)}
                canManage={canManage}
                itemId={item.itemId}
                indent
              />
            ))}
          </Fragment>
        ))}
      </Section>

      <Section id="mapping-methods" title="Cara bayar" description="Tunai ke Kas tunai, transfer dan kartu debit ke Bank utama. Hanya akun Kas & Bank yang bisa dipilih.">
        {page.paymentMethods.map((row) => (
          <MappingRow key={row.mappingKey} mappingKey={row.mappingKey} label={row.label} accountCode={row.accountCode} options={optionsFor(row.mappingKey, row.accountCode, page)} canManage={canManage} />
        ))}
      </Section>

      <Section id="mapping-channels" title="Penjualan per kanal" description="Akun pendapatan untuk penjualan setiap kanal.">
        {page.channels.map((row) => (
          <MappingRow key={row.mappingKey} mappingKey={row.mappingKey} label={row.label} accountCode={row.accountCode} options={optionsFor(row.mappingKey, row.accountCode, page)} canManage={canManage} />
        ))}
      </Section>

      <p className="text-sm text-neutral-600">
        Akun baru ditambahkan di{" "}
        <Link href="/accounting/accounts" className="font-medium text-brand hover:underline">
          Data Master Akun
        </Link>
        .
      </p>
    </>
  );
}

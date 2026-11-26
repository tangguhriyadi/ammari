import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { suggestChildCode } from "@/lib/accounting/account-input";
import { headerOptions, listAccounts } from "@/lib/accounting/accounts";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { AccountForm } from "../_components/account-form";

// Add an account (Session 3). ?parent=<header code> preselects the parent ("Tambah sub-akun").
export default async function NewAccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAllPermissions(["accounting.view", "accounting.manage"]);
  const raw = (await searchParams).parent;
  const parent = typeof raw === "string" ? raw : null;
  const headers = headerOptions(await listAccounts(), suggestChildCode);
  const initialParentCode = headers.some((header) => header.code === parent) ? parent : null;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/accounts"), { label: "Tambah akun" }]} />
      <PageHeader
        title="Tambah Akun"
        description="Rekening bank kedua, misalnya, ditambahkan sebagai sub-akun di bawah kelompok Bank. Kode, jenis dan saldo normal tidak bisa diubah setelah disimpan."
      />
      <AccountForm mode="create" headers={headers} initialParentCode={initialParentCode} />
    </>
  );
}

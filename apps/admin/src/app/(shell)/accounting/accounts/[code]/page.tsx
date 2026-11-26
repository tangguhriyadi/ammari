import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, Button, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { suggestChildCode } from "@/lib/accounting/account-input";
import { getAccount, headerOptions, listAccounts } from "@/lib/accounting/accounts";
import { ACCOUNT_TYPE_LABELS, CASH_FLOW_GROUP_LABELS, NORMAL_BALANCE_LABELS } from "@/lib/accounting/labels";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { AccountForm } from "../_components/account-form";
import { AccountStatusControl } from "../_components/account-status-control";

// One account (Session 3): its facts, and for accounting.manage the edit form (name, parent, bank
// fields, cash-flow group), Nonaktifkan/Aktifkan and Hapus (unused accounts only).
export default async function AccountDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const { code } = await params;
  const [account, rows] = await Promise.all([getAccount(code), listAccounts()]);
  if (!account) notFound();
  const parent = rows.find((row) => row.code === account.parentCode) ?? null;
  // Parent choices on edit: active headers of the same type, never the account itself or one of its
  // descendants (the tree trigger refuses a cycle anyway), plus the current parent even if inactive.
  const descendants = new Set<string>([account.code]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (row.parentCode && descendants.has(row.parentCode) && !descendants.has(row.code)) {
        descendants.add(row.code);
        grew = true;
      }
    }
  }
  const parentChoices = headerOptions(rows, suggestChildCode).filter((header) => header.type === account.type && !descendants.has(header.code));
  if (parent && !parentChoices.some((header) => header.code === parent.code)) {
    parentChoices.unshift({ code: parent.code, name: `${parent.name}${parent.isActive ? "" : " (nonaktif)"}`, type: parent.type, suggestedCode: null });
  }
  const canDelete = !account.isSystem && account.lineCount === 0 && account.childCount === 0 && account.mappingKeys.length === 0;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/accounts"), { label: `${account.code} ${account.name}` }]} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageHeader title={`${account.code} ${account.name}`} description={`${ACCOUNT_TYPE_LABELS[account.type]}, saldo normal ${NORMAL_BALANCE_LABELS[account.normalBalance].toLowerCase()}`} />
        <div className="flex items-center gap-2">
          {account.isHeader && <Badge variant="neutral">Kelompok</Badge>}
          {account.isSystem && <Badge variant="warning">Sistem</Badge>}
          {!account.isActive && <Badge variant="neutral">Nonaktif</Badge>}
        </div>
      </div>
      <dl className="mb-6 grid max-w-xl grid-cols-1 gap-x-6 gap-y-2 text-base sm:grid-cols-2">
        <dt className="text-neutral-600">Akun induk</dt>
        <dd>{parent ? `${parent.code} ${parent.name}` : "Tanpa induk"}</dd>
        <dt className="text-neutral-600">Kelompok arus kas</dt>
        <dd>{CASH_FLOW_GROUP_LABELS[account.cashFlowGroup]}</dd>
        <dt className="text-neutral-600">Baris jurnal</dt>
        <dd className="tabular-nums">{account.lineCount}</dd>
        <dt className="text-neutral-600">Dipakai pemetaan</dt>
        <dd>{account.mappingKeys.length === 0 ? "Tidak" : `${account.mappingKeys.length} pemetaan`}</dd>
      </dl>
      {canManage ? (
        <div className="flex flex-col gap-6">
          <AccountForm
            key={`${account.name}:${account.parentCode}:${account.bankName}:${account.accountNoLast4}:${account.cashFlowGroup}`}
            mode="edit"
            code={account.code}
            type={account.type}
            isHeader={account.isHeader}
            isSystem={account.isSystem}
            headers={parentChoices}
            initialValues={{
              name: account.name,
              parentCode: account.parentCode,
              cashFlowGroup: account.cashFlowGroup,
              bankName: account.bankName ?? "",
              accountNoLast4: account.accountNoLast4 ?? "",
            }}
          />
          {account.isHeader && account.isActive && (
            <div>
              <Link href={`/accounting/accounts/new?parent=${account.code}`}>
                <Button variant="secondary">Tambah sub-akun</Button>
              </Link>
            </div>
          )}
          <AccountStatusControl code={account.code} name={account.name} isActive={account.isActive} isSystem={account.isSystem} canDelete={canDelete} />
        </div>
      ) : (
        <Link href="/accounting/accounts" className="text-base font-medium text-brand hover:underline">
          Kembali ke daftar
        </Link>
      )}
    </>
  );
}

import Link from "next/link";
import { Breadcrumb, Card, PageHeader } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { listJournalAccountChoices } from "@/lib/accounting/manual-journals";
import { getOpeningBalancePage, OPENING_BALANCE_MESSAGES } from "@/lib/accounting/opening-balance";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { OpeningBalanceForm } from "./_components/opening-balance-form";

// Saldo awal (docs/plans/accounting.md §5.4, D-22, Session 4): the opening balances as of
// 31 Dec 2026 for the official books from 1 Jan 2027. Read with accounting.view; posting needs
// accounting.manage (the form is shown read-only without it, and the action re-checks). Only one
// opening journal is ever active; a wrong one is reversed on Jurnal Umum and entered again.

export default async function OpeningBalancePage() {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const [page, choices] = await Promise.all([getOpeningBalancePage(), listJournalAccountChoices()]);
  const equity = choices.find((choice) => choice.systemKey === "equity.opening_balance");
  const blockedReason = !canManage
    ? "Hanya pemilik atau akuntan dengan izin kelola akuntansi yang bisa membukukan saldo awal."
    : page.activeOpening
      ? OPENING_BALANCE_MESSAGES.alreadyPosted
      : page.canPost
        ? null
        : OPENING_BALANCE_MESSAGES.tooEarly;

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/opening-balance")} />
      <PageHeader
        title="Saldo Awal"
        description="Pembukuan resmi mulai 1 Januari 2027 dengan saldo per 31 Desember 2026. Desember 2026 adalah bulan uji coba: jurnalnya tidak dipakai di sini dan tidak terbawa ke 2027."
      />
      {page.activeOpening && (
        <Card className="mb-6 flex flex-col gap-1" data-testid="active-opening">
          <span className="font-medium text-neutral-900">Saldo awal sudah dibukukan: {page.activeOpening.entryNo}</span>
          <span className="text-sm text-neutral-600">Dicatat {formatDateTime(page.activeOpening.createdAt)} WIB.</span>
          <Link href="/accounting/journal?from=2027-01-01&to=2027-01-31&kind=opening" className="text-sm font-medium text-brand hover:underline">
            Lihat di Jurnal Umum (untuk membalik bila salah)
          </Link>
        </Card>
      )}
      <OpeningBalanceForm
        proposals={page.proposals.map(({ key, accountCode, accountName, label, basis, amount }) => ({ key, accountCode, accountName, label, basis, amount }))}
        typedAccounts={page.typedAccounts}
        accounts={choices.map(({ code, name }) => ({ code, name }))}
        equityAccountLabel={equity ? `${equity.code} ${equity.name}` : "Ekuitas saldo awal"}
        canPost={canManage && page.canPost}
        blockedReason={blockedReason}
      />
    </>
  );
}

import { Breadcrumb, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { defaultManualJournalDate, MANUAL_JOURNAL_TEMPLATES } from "@/lib/accounting/manual-journal-input";
import { listJournalAccountChoices } from "@/lib/accounting/manual-journals";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ManualJournalForm, type ResolvedTemplate } from "../_components/manual-journal-form";

// "Catat jurnal manual" (docs/plans/accounting.md §5, Session 4): only for what the system does not
// record. accounting.view + accounting.manage (plan §7); the action re-checks. Templates name their
// accounts by system key, resolved here to today's codes (the accountant may rename/renumber).

export default async function NewManualJournalPage() {
  await requireAllPermissions(["accounting.view", "accounting.manage"]);
  const choices = await listJournalAccountChoices();
  const bySystemKey = new Map(choices.filter((row) => row.systemKey).map((row) => [row.systemKey as string, row.code]));
  const templates: ResolvedTemplate[] = MANUAL_JOURNAL_TEMPLATES.flatMap((template) => {
    const lines = template.lines.map((line) => ({ accountCode: bySystemKey.get(line.systemKey), side: line.side }));
    if (lines.some((line) => !line.accountCode)) return [];
    return [{ key: template.key, label: template.label, description: template.description, hint: template.hint, lines: lines as ResolvedTemplate["lines"] }];
  });

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/journal"), { label: "Jurnal manual" }]} />
      <PageHeader
        title="Catat Jurnal Manual"
        description="Hanya untuk hal yang tidak dicatat aplikasi: modal, prive, top-up Biteship, penarikan saldo, penyesuaian akhir bulan. Jurnal tidak bisa diubah; yang salah dibalik lalu dicatat ulang."
      />
      <ManualJournalForm accounts={choices.map((row) => ({ code: row.code, name: row.name }))} templates={templates} defaultDate={defaultManualJournalDate(jakartaDate())} />
    </>
  );
}

import { EXPENSE_LIKE_ACCOUNT_TYPES, PURCHASE_SIDE_JOURNAL_SOURCES, type AccountType } from "@ammari/db/schema";
import type { JournalLineDraft } from "./journal";

// D-14 (docs/plans/accounting-decisions.md): fabric and accessory purchases are always inventory,
// and supplier payments only clear utang or build an advance; a purchase-side journal never
// touches an expense, HPP, other-expense or tax account. The runner checks a rule's lines here
// before writing; the journal_line_purchase_guard trigger (migration 0049) refuses the same lines
// in the database. Both read PURCHASE_SIDE_JOURNAL_SOURCES / EXPENSE_LIKE_ACCOUNT_TYPES.

export interface JournalSourceKey {
  sourceType: string;
  sourceEvent: string;
}

export function isPurchaseSideSource(source: JournalSourceKey): boolean {
  return PURCHASE_SIDE_JOURNAL_SOURCES.some(
    (guarded) => guarded.sourceType === source.sourceType && (guarded.event === null || guarded.event === source.sourceEvent),
  );
}

export function isExpenseLikeAccountType(type: AccountType): boolean {
  return (EXPENSE_LIKE_ACCOUNT_TYPES as readonly AccountType[]).includes(type);
}

/** The lines of a purchase-side journal that would post to an expense-like account (empty when
 * none do, or when the source is not purchase-side). An unknown account code counts as a
 * violation: the guard never assumes an account it cannot classify is safe. This is stricter
 * than the database trigger, which leaves an unknown code to the journal_lines account FK. */
export function purchaseGuardViolations(
  source: JournalSourceKey,
  lines: readonly JournalLineDraft[],
  accountTypeOf: (accountCode: string) => AccountType | undefined,
): JournalLineDraft[] {
  if (!isPurchaseSideSource(source)) return [];
  return lines.filter((line) => {
    const type = accountTypeOf(line.accountCode);
    return type === undefined || isExpenseLikeAccountType(type);
  });
}

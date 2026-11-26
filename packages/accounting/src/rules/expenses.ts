import type { BusinessExpenseMethod, ChannelId } from "@ammari/db/schema";
import { jakartaDateOf } from "../dates";
import type { JournalLineDraft } from "../journal";
// An inventory account (1-15xx): expenses never land there, since raw materials reach inventory
// only through goods receipts (plan §3 guard, D-14) and an expense mapped to one would count the
// same stock twice. The mapping editor and migration 0051's trigger refuse such a mapping; the
// engine refuses it too, for a mapping written before 0051.
import { isInventoryAccountCode } from "../mapping-rules";
import { mappedAccount, negateOutcome, resolveOrIssue, systemAccount, PostingIssueError, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// Business expenses (docs/plans/accounting.md §4.7):
//   E1 (business_expense, id, paid), dated expense_date:
//     Dr the mapped account [D-25] (expense.item.<id> when set, else expense.category.<code>;
//        unmapped → posting issue) / Cr by method: cash → cash.method.cash (1-1101), transfer →
//        cash.method.transfer (1-1201) [D-17], card (debit card) → cash.method.card (1-1201)
//        [D-18], platform_balance → M4: Saldo Penjual Shopee/TikTok when the expense names that
//        channel, else 1-1305 Saldo marketplace belum dipilah [D-11].
//   E2 (business_expense, id, void), dated voided_at (Jakarta): the exact negation of E1.

export const EXPENSE_SOURCE_TYPE = "business_expense";

export interface ExpenseSnapshot {
  id: string;
  expenseNo: string;
  /** Jakarta day the money left. */
  expenseDate: string;
  categoryCode: string;
  categoryName: string;
  itemId: string | null;
  itemName: string | null;
  amount: number;
  method: BusinessExpenseMethod;
  channelId: ChannelId | null;
  voidedAt: Date | null;
}

const PLATFORM_BALANCE_BY_CHANNEL: Partial<Record<ChannelId, string>> = {
  shopee: "seller_balance.shopee",
  tiktok: "seller_balance.tiktok",
};

function expenseAccount(expense: ExpenseSnapshot, context: PostingContext): string {
  const itemCode = expense.itemId ? context.mappings.get(`expense.item.${expense.itemId}`) : undefined;
  const code =
    itemCode ??
    mappedAccount(context, `expense.category.${expense.categoryCode}`, "unmapped_expense_category", {
      category: expense.categoryCode,
      categoryName: expense.categoryName,
    });
  if (isInventoryAccountCode(code)) {
    throw new PostingIssueError("expense_mapped_to_inventory", { category: expense.categoryCode, itemId: expense.itemId, accountCode: code });
  }
  return code;
}

function paymentAccount(expense: ExpenseSnapshot, context: PostingContext): string {
  if (expense.method === "platform_balance") {
    const systemKey = (expense.channelId && PLATFORM_BALANCE_BY_CHANNEL[expense.channelId]) ?? "seller_balance.unallocated";
    return systemAccount(context, systemKey);
  }
  return mappedAccount(context, `cash.method.${expense.method}`, "unmapped_payment_method", { method: expense.method });
}

function describe(expense: ExpenseSnapshot): string {
  const what = expense.itemName ? `${expense.categoryName}, ${expense.itemName}` : expense.categoryName;
  return `Biaya ${expense.expenseNo}: ${what}`;
}

/** E1's journal. */
export function expensePaidOutcome(expense: ExpenseSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const debitAccount = expenseAccount(expense, context);
    const creditAccount = paymentAccount(expense, context);
    const dimensions = { channelId: expense.channelId, cashAccountCode: creditAccount };
    const lines: JournalLineDraft[] = [
      { accountCode: debitAccount, debit: expense.amount, credit: 0, ...dimensions },
      { accountCode: creditAccount, debit: 0, credit: expense.amount, ...dimensions },
    ];
    return { kind: "journal", description: describe(expense), lines };
  });
}

export const expenseRule: PostingRule<ExpenseSnapshot> = {
  name: "business_expense",
  ruleVersion: 1,
  events(expense, context) {
    const key = (sourceEvent: string) => ({ sourceType: EXPENSE_SOURCE_TYPE, sourceId: expense.id, sourceEvent });
    // Cut-over (plan §2): an expense dated before the posting start lives in the opening balances,
    // so E1 is not posted. E2 is posted only while E1 has an active journal (the runner checks):
    // a void of a record that was never posted does nothing, since its effect is already in the
    // opening balances.
    const paid: PostingOutcome = expense.expenseDate < context.postingStartDate ? { kind: "none" } : expensePaidOutcome(expense, context);
    const events: PostingEvent[] = [{ key: key("paid"), sourceDate: expense.expenseDate, outcome: paid }];
    if (expense.voidedAt) {
      events.push({
        key: key("void"),
        sourceDate: jakartaDateOf(expense.voidedAt),
        // Built from the rule, not copied from the stored journal, so a re-map re-derives both.
        outcome: negateOutcome(expensePaidOutcome(expense, context), `Pembatalan biaya ${expense.expenseNo}`),
        requiresActiveJournalFor: key("paid"),
      });
    }
    return events;
  },
};

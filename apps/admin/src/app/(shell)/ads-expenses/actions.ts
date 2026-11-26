"use server";

import { z } from "zod";
import { BUSINESS_EXPENSE_METHODS, CHANNEL_IDS } from "@ammari/db/schema";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { getSelectableExpenseCategoryAndItem } from "@/lib/expense-categories/queries";
import { EXPENSE_MESSAGES, MAX_VOID_REASON_LENGTH, findProofHashUses, normalizeExpenseInput, recordBusinessExpense, voidBusinessExpense } from "@/lib/expenses/records";
import { parseRupiah } from "@/lib/products/money";
import { fieldErrorsOf, firstIssue, text, uploadedFile } from "@/lib/supplier-payments/form-input";
import { PROOF_MESSAGES, processPrivateUpload } from "@/lib/supplier-payments/proof-processing";
import { storePrivateUpload } from "@/lib/supplier-payments/store-upload";

// "Iklan & Biaya" actions (docs/plans/growth.md §5, §7, session S2). Every action re-checks
// ads_expenses.manage + finance.view_profit on the server: an expense is a cost figure, and the
// proof is private.

const EXPENSE_KEYS = ["ads_expenses.manage", "finance.view_profit"] as const;

const recordSchema = z.object({
  expenseDate: z.string().date(EXPENSE_MESSAGES.invalidDate),
  // An expense_categories code; whether it exists and is active is checked against the table
  // (getSelectableExpenseCategoryAndItem here, the FOR SHARE lock in the write, the FK as backstop).
  category: z.string({ message: "Pilih kategori." }).trim().min(1, "Pilih kategori.").max(40, "Pilih kategori."),
  // An expense_items id, or empty for "no item". Whether it belongs to the category, is active, or
  // is required at all is checked against the table, like the category.
  itemId: z
    .union([z.literal(""), z.string().uuid("Item biaya tidak ditemukan.")], { message: "Item biaya tidak ditemukan." })
    .transform((value) => (value === "" ? null : value)),
  amount: z.string().transform((value, ctx) => {
    const parsed = parseRupiah(value);
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: EXPENSE_MESSAGES.amount });
      return z.NEVER;
    }
    return parsed;
  }),
  method: z.enum(BUSINESS_EXPENSE_METHODS, { message: "Pilih metode pembayaran." }),
  // An empty select means "no channel".
  channelId: z.union([z.literal(""), z.enum(CHANNEL_IDS)], { message: "Pilih kanal." }).transform((value) => (value === "" ? null : value)),
  campaign: z.string().optional(),
  note: z.string().optional(),
});

/** "Catat biaya" (plan §5): validate everything first, then process + store the proof, then ONE
 * transaction for the file row, the expense row and the audit entry. */
export async function recordBusinessExpenseAction(formData: FormData): Promise<ActionResult<{ expenseNo: string }>> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  const parsed = recordSchema.safeParse({
    expenseDate: text(formData, "expenseDate"),
    category: text(formData, "category"),
    itemId: text(formData, "itemId") ?? "",
    amount: text(formData, "amount") ?? "",
    method: text(formData, "method"),
    channelId: text(formData, "channelId") ?? "",
    campaign: text(formData, "campaign"),
    note: text(formData, "note"),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error), fieldErrors: fieldErrorsOf(parsed.error) };
  const upload = uploadedFile(formData, "proof", PROOF_MESSAGES.missing);
  if ("error" in upload) return { ok: false, error: upload.error, fieldErrors: { proof: upload.error } };

  return runAction(async () => {
    // Every rule before storing anything, so a refused form leaves no unreferenced object. An
    // unknown or inactive category or item, an item of another category, and a missing item where
    // the category has items are refused here; the write re-checks them under a lock, so a change
    // in the moment between the two leaves the stored proof unreferenced (as any failed write
    // after storePrivateUpload does today).
    const { category } = await getSelectableExpenseCategoryAndItem(parsed.data.category, parsed.data.itemId);
    const input = normalizeExpenseInput(parsed.data, category);
    const processed = await processPrivateUpload(Buffer.from(await upload.file.arrayBuffer()), upload.file.name);
    const stored = await storePrivateUpload(processed, "expense_proof");
    const row = await recordBusinessExpense(input, stored, session.staffUser.id);
    revalidateAdmin("/ads-expenses");
    return { expenseNo: row.expenseNo };
  });
}

const voidSchema = z.object({
  id: z.string().uuid(EXPENSE_MESSAGES.notFound),
  reason: z.string().trim().min(1, EXPENSE_MESSAGES.reasonRequired).max(MAX_VOID_REASON_LENGTH, EXPENSE_MESSAGES.reasonTooLong),
});

/** "Batalkan" (plan G3): void once, with a required reason. */
export async function voidBusinessExpenseAction(input: z.input<typeof voidSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await voidBusinessExpense(parsed.data.id, parsed.data.reason, session.staffUser.id);
    revalidateAdmin("/ads-expenses");
    return undefined;
  });
}

/** Plan §5 step 4: advisory only. The hash is of the exact bytes the browser is about to upload.
 * Supplier payment numbers are included only for a viewer allowed to see them. */
export async function findExpenseProofDuplicatesAction(input: { sha256: string }): Promise<ActionResult<{ documentNos: string[] }>> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  const parsed = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(input);
  if (!parsed.success) return { ok: true, data: { documentNos: [] } };
  const includeSupplierPayments = session.permissionKeys.includes("supplier_payments.manage");
  return runAction(async () => ({ documentNos: await findProofHashUses(parsed.data.sha256, { includeSupplierPayments }) }));
}

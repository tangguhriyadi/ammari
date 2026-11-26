"use server";

import { z } from "zod";
import { EXPENSE_CATEGORY_KINDS } from "@ammari/db/schema";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import * as expenseCategoryQueries from "@/lib/expense-categories/queries";
import { EXPENSE_CATEGORY_MESSAGES } from "@/lib/expense-categories/queries";
import { parseRupiah } from "@/lib/products/money";

// "Kategori Biaya" Data Master actions (docs/plans/expense-master-data.md §3.6, session S3).
// Same permission pair as recording an expense (owner answer D5), re-checked on every action. The
// query module does the name rules (trim, length, reserved "Biaya produksi", unique) and writes the
// audit entry in the same transaction; this layer only shapes the input.

const EXPENSE_KEYS = ["ads_expenses.manage", "finance.view_profit"] as const;

// Category names show on the expense list, its filters, the reports and the monthly-bill options.
const SECTIONS = ["/expense-categories", "/ads", "/expenses", "/settings"] as const;

const INVALID_INPUT = "Input tidak valid.";

// The form sends the typed text ("12"); a number is accepted too. Not z.coerce: that would turn
// null/true/[5] into 0/1/5.
const sortOrderNumber = z
  .union(
    [
      z.number(),
      z
        .string()
        .trim()
        .regex(/^-?\d+$/, EXPENSE_CATEGORY_MESSAGES.sortOrder)
        .transform(Number),
    ],
    { error: EXPENSE_CATEGORY_MESSAGES.sortOrder },
  )
  .pipe(
    z
      .number({ error: EXPENSE_CATEGORY_MESSAGES.sortOrder })
      .int(EXPENSE_CATEGORY_MESSAGES.sortOrder)
      .min(0, "Urutan tidak boleh negatif.")
      .max(9999, "Urutan maksimal 9999."),
  );
/** Create: a missing order is 0. Update: required, so an omitted field never resets it. */
const sortOrderOnCreate = sortOrderNumber.default(0);

// Generous caps only to bound the payload; the real length rules (60/80/200) are in the queries.
const nameSchema = (message: string) =>
  z.string({ error: message }).max(500, message);

const categoryFieldsSchema = z.object(
  {
    name: nameSchema(EXPENSE_CATEGORY_MESSAGES.nameTooLong),
    sortOrder: sortOrderNumber,
  },
  { error: INVALID_INPUT },
);

const createCategorySchema = categoryFieldsSchema.extend({
  sortOrder: sortOrderOnCreate,
  kind: z.enum(EXPENSE_CATEGORY_KINDS, {
    error: EXPENSE_CATEGORY_MESSAGES.kind,
  }),
});

const categoryCodeSchema = z.string().min(1).max(40);

const itemFieldsSchema = z.object(
  {
    name: nameSchema(EXPENSE_CATEGORY_MESSAGES.itemNameTooLong),
    // Payload bound only; the 200-character rule and its message are the query's.
    note: z
      .string({ error: INVALID_INPUT })
      .max(1000, INVALID_INPUT)
      .optional(),
    // Typed as text ("149.000"); empty means no default amount.
    defaultAmount: z
      .string({ error: EXPENSE_CATEGORY_MESSAGES.itemDefaultAmount })
      .max(40, EXPENSE_CATEGORY_MESSAGES.itemDefaultAmount)
      .optional()
      .transform((value, ctx) => {
        if (value === undefined || value.trim() === "") return null;
        const parsed = parseRupiah(value);
        if (parsed === null) {
          ctx.addIssue({
            code: "custom",
            message: EXPENSE_CATEGORY_MESSAGES.itemDefaultAmount,
          });
          return z.NEVER;
        }
        return parsed;
      }),
    sortOrder: sortOrderNumber,
  },
  { error: INVALID_INPUT },
);

const createItemSchema = itemFieldsSchema.extend({
  sortOrder: sortOrderOnCreate,
});

const itemIdSchema = z.string().uuid(EXPENSE_CATEGORY_MESSAGES.itemNotFound);

function validationError(error: z.ZodError): ActionResult<never> {
  const issue = error.issues[0];
  const message = issue?.message ?? INVALID_INPUT;
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  return {
    ok: false,
    error: message,
    fieldErrors: field ? { [field]: message } : undefined,
  };
}

export async function createExpenseCategoryAction(
  input: z.input<typeof createCategorySchema>,
): Promise<ActionResult<{ code: string }>> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  const parsed = createCategorySchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const created = await expenseCategoryQueries.createExpenseCategory(
      parsed.data,
      session.staffUser.id,
    );
    revalidateAdmin(...SECTIONS);
    return { code: created.code };
  });
}

/** Name and order only: code, kind and the fixed channel are immutable (plan §3.1). */
export async function updateExpenseCategoryAction(
  code: string,
  input: z.input<typeof categoryFieldsSchema>,
): Promise<ActionResult<{ code: string }>> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  if (!categoryCodeSchema.safeParse(code).success)
    return { ok: false, error: EXPENSE_CATEGORY_MESSAGES.categoryNotFound };
  const parsed = categoryFieldsSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const updated = await expenseCategoryQueries.updateExpenseCategory(
      code,
      parsed.data,
      session.staffUser.id,
    );
    revalidateAdmin(...SECTIONS);
    return { code: updated.code };
  });
}

const setCategoryActiveSchema = z.object(
  { code: categoryCodeSchema, isActive: z.boolean() },
  { error: INVALID_INPUT },
);

/** A system category is refused by the query (friendly) and a CHECK (backstop). */
export async function setExpenseCategoryActiveAction(
  input: z.input<typeof setCategoryActiveSchema>,
): Promise<ActionResult> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  const parsed = setCategoryActiveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: EXPENSE_CATEGORY_MESSAGES.categoryNotFound };
  return runAction(async () => {
    await expenseCategoryQueries.setExpenseCategoryActive(
      parsed.data.code,
      parsed.data.isActive,
      session.staffUser.id,
    );
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

export async function createExpenseItemAction(
  categoryCode: string,
  input: z.input<typeof createItemSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  if (!categoryCodeSchema.safeParse(categoryCode).success)
    return { ok: false, error: EXPENSE_CATEGORY_MESSAGES.categoryNotFound };
  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const created = await expenseCategoryQueries.createExpenseItem(
      categoryCode,
      parsed.data,
      session.staffUser.id,
    );
    revalidateAdmin(...SECTIONS);
    return { id: created.id };
  });
}

export async function updateExpenseItemAction(
  id: string,
  input: z.input<typeof itemFieldsSchema>,
): Promise<ActionResult> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  if (!itemIdSchema.safeParse(id).success)
    return { ok: false, error: EXPENSE_CATEGORY_MESSAGES.itemNotFound };
  const parsed = itemFieldsSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await expenseCategoryQueries.updateExpenseItem(
      id,
      parsed.data,
      session.staffUser.id,
    );
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

const setItemActiveSchema = z.object(
  { id: itemIdSchema, isActive: z.boolean() },
  { error: INVALID_INPUT },
);

export async function setExpenseItemActiveAction(
  input: z.input<typeof setItemActiveSchema>,
): Promise<ActionResult> {
  const session = await requireAllPermissions(EXPENSE_KEYS);
  const parsed = setItemActiveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: EXPENSE_CATEGORY_MESSAGES.itemNotFound };
  return runAction(async () => {
    await expenseCategoryQueries.setExpenseItemActive(
      parsed.data.id,
      parsed.data.isActive,
      session.staffUser.id,
    );
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

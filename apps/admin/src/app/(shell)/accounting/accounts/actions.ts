"use server";

import { z } from "zod";
import { ACCOUNT_NORMAL_BALANCES, ACCOUNT_TYPES, CASH_FLOW_GROUPS } from "@ammari/db/schema";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { ACCOUNT_MESSAGES } from "@/lib/accounting/account-input";
import * as accountQueries from "@/lib/accounting/accounts";

// Data Master Akun (docs/plans/accounting.md Session 3). Plan §7: the Chart of Accounts is
// accounting.manage; the pages are accounting.view, so both are required, re-checked on every
// action. The query module applies the rules and audits; this layer only shapes the input.

const KEYS = ["accounting.view", "accounting.manage"] as const;
// Account names show on the journal, ledger and mapping pages, and categories show their account.
const SECTIONS = ["/accounting", "/expense-categories"] as const;
const INVALID_INPUT = "Input tidak valid.";

const text = (max: number) => z.string({ error: INVALID_INPUT }).max(max, INVALID_INPUT);
const optionalText = (max: number) => text(max).nullable().optional();
const codeSchema = z.string().regex(/^[1-9]-[0-9]{4}$/, ACCOUNT_MESSAGES.notFound);

const createSchema = z.object(
  {
    code: text(20),
    name: text(500),
    type: z.enum(ACCOUNT_TYPES, { error: ACCOUNT_MESSAGES.type }),
    normalBalance: z.enum(ACCOUNT_NORMAL_BALANCES, { error: ACCOUNT_MESSAGES.normalBalance }),
    parentCode: optionalText(20),
    isHeader: z.boolean({ error: INVALID_INPUT }),
    cashFlowGroup: z.enum(CASH_FLOW_GROUPS, { error: ACCOUNT_MESSAGES.cashFlowGroup }).optional(),
    bankName: optionalText(500),
    accountNoLast4: optionalText(50),
  },
  { error: INVALID_INPUT },
);

const updateSchema = z.object(
  {
    name: text(500),
    parentCode: optionalText(20),
    cashFlowGroup: z.enum(CASH_FLOW_GROUPS, { error: ACCOUNT_MESSAGES.cashFlowGroup }).optional(),
    bankName: optionalText(500),
    accountNoLast4: optionalText(50),
  },
  { error: INVALID_INPUT },
);

function validationError(error: z.ZodError): ActionResult<never> {
  const issue = error.issues[0];
  const message = issue?.message ?? INVALID_INPUT;
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  return { ok: false, error: message, fieldErrors: field ? { [field]: message } : undefined };
}

export async function createAccountAction(input: z.input<typeof createSchema>): Promise<ActionResult<{ code: string }>> {
  const session = await requireAllPermissions(KEYS);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const created = await accountQueries.createAccount({ ...parsed.data, parentCode: parsed.data.parentCode || null }, session.staffUser.id);
    revalidateAdmin(...SECTIONS);
    return { code: created.code };
  });
}

export async function updateAccountAction(code: string, input: z.input<typeof updateSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (!codeSchema.safeParse(code).success) return { ok: false, error: ACCOUNT_MESSAGES.notFound };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await accountQueries.updateAccount(code, { ...parsed.data, parentCode: parsed.data.parentCode || null }, session.staffUser.id);
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

const setActiveSchema = z.object({ code: codeSchema, isActive: z.boolean() }, { error: INVALID_INPUT });

export async function setAccountActiveAction(input: z.input<typeof setActiveSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: ACCOUNT_MESSAGES.notFound };
  return runAction(async () => {
    await accountQueries.setAccountActive(parsed.data.code, parsed.data.isActive, session.staffUser.id);
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

export async function deleteAccountAction(code: string): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (!codeSchema.safeParse(code).success) return { ok: false, error: ACCOUNT_MESSAGES.notFound };
  return runAction(async () => {
    await accountQueries.deleteAccount(code, session.staffUser.id);
    revalidateAdmin(...SECTIONS);
    return undefined;
  });
}

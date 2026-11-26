import "server-only";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { isAccountCode, isCashBankAccountCode } from "@ammari/accounting";
import { accountMappings, accounts, journalLines, type AccountNormalBalance, type AccountType, type CashFlowGroup } from "@ammari/db/schema";
import { qualifiedColumn as q } from "@ammari/db/sql-helpers";
import { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import {
  ACCOUNT_MESSAGES,
  assertValidParent,
  cashFlowGroupIsChosen,
  normalizeAccountName,
  normalizeBankFields,
  resolveCashFlowGroup,
  validateNewAccount,
  type NewAccountInput,
  type ParentInfo,
} from "./account-input";

// Data Master "Akun" (docs/plans/accounting.md Session 3, §5.2, §8.1): list, add a (sub-)account,
// rename, move, bank fields, deactivate, delete an unused one. Callers check accounting.view
// (reads) or accounting.view + accounting.manage (writes). Every write locks the account row, applies
// account-input.ts's rules for a clear message, writes, and audits in the same transaction; the
// CHECKs and triggers of migrations 0049/0051 refuse the same things and map back to the same
// messages if a concurrent change slips between the check and the write.

const CONSTRAINT_FIELDS = {
  accounts_pkey: { field: "code", message: ACCOUNT_MESSAGES.codeTaken },
  accounts_name_unique: { field: "name", message: ACCOUNT_MESSAGES.nameTaken },
};

/** The Postgres error's own message (drizzle may wrap it in `cause`). */
function databaseMessage(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return cause instanceof Error ? cause.message : "";
}

/** A trigger/CHECK refusal from 0049/0051 as the editor's own message; anything else rethrown. */
function mapAccountError(error: unknown): never {
  mapUniqueViolationOrPass(error);
  if (isPostgresErrorCode(error, "23514")) {
    const message = databaseMessage(error);
    if (/must be a header/.test(message)) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentNotHeader);
    if (/parent's type/.test(message)) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentType);
    if (/would make a cycle/.test(message)) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentCycle);
    if (/accounts_code_type_check|accounts_code_check/.test(message)) throw new FieldError("code", ACCOUNT_MESSAGES.codeFormat);
    if (/accounts_bank_fields_cash_bank_check/.test(message)) throw new FieldError("bankName", ACCOUNT_MESSAGES.bankFieldsNotAllowed);
    if (/mapping points at cannot be deactivated/.test(message)) throw new ActionError(ACCOUNT_MESSAGES.mappedCannotDeactivate);
    if (/accounts_system_active_check/.test(message)) throw new ActionError(ACCOUNT_MESSAGES.systemCannotDeactivate);
    if (/system accounts are never deleted/.test(message)) throw new ActionError(ACCOUNT_MESSAGES.systemCannotDelete);
    if (/journal lines is never deleted/.test(message)) throw new ActionError(ACCOUNT_MESSAGES.usedCannotDelete);
  }
  if (isPostgresErrorCode(error, "23503")) {
    const message = databaseMessage(error);
    if (/account_mappings/.test(message)) throw new ActionError(ACCOUNT_MESSAGES.mappedCannotDelete);
    if (/parent_code/.test(message) && /delete/.test(message)) throw new ActionError(ACCOUNT_MESSAGES.childrenCannotDelete);
    if (/parent_code/.test(message)) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentNotFound);
  }
  throw error;
}

function mapUniqueViolationOrPass(error: unknown): void {
  if (!isPostgresErrorCode(error, "23505")) return;
  mapUniqueViolation(error, CONSTRAINT_FIELDS);
}

// ---------- Reads ----------

export interface AccountRow {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: AccountNormalBalance;
  parentCode: string | null;
  isHeader: boolean;
  isSystem: boolean;
  isActive: boolean;
  cashFlowGroup: CashFlowGroup;
  bankName: string | null;
  accountNoLast4: string | null;
  sortOrder: number;
}

export interface AccountListRow extends AccountRow {
  /** Ancestors above it, for indentation. */
  depth: number;
  /** A postable Kas & Bank account (D-17). */
  isCashBank: boolean;
}

const accountColumns = {
  code: accounts.code,
  name: sql<string>`${accounts.name}::text`,
  type: accounts.type,
  normalBalance: accounts.normalBalance,
  parentCode: accounts.parentCode,
  isHeader: accounts.isHeader,
  isSystem: accounts.isSystem,
  isActive: accounts.isActive,
  cashFlowGroup: accounts.cashFlowGroup,
  bankName: accounts.bankName,
  accountNoLast4: accounts.accountNoLast4,
  sortOrder: accounts.sortOrder,
};

/** Every account in code order (the accountant's own order), with its depth in the tree. */
export async function listAccounts(db: Database = defaultDb): Promise<AccountListRow[]> {
  const rows = await db.select(accountColumns).from(accounts).orderBy(asc(accounts.code));
  const parentOf = new Map(rows.map((row) => [row.code, row.parentCode]));
  const depthOf = (code: string): number => {
    let depth = 0;
    let parent = parentOf.get(code) ?? null;
    // Bounded by the row count: the tree trigger keeps it acyclic, this keeps a bad row harmless.
    while (parent !== null && depth < rows.length) {
      depth += 1;
      parent = parentOf.get(parent) ?? null;
    }
    return depth;
  };
  return rows.map((row) => ({ ...row, depth: depthOf(row.code), isCashBank: !row.isHeader && isCashBankAccountCode(row.code) }));
}

/** Active postable Kas & Bank accounts (D-17): today Kas tunai and Bank utama. The payment-method
 * mappings and (Session 6) the manual-order account picker list these. */
export function cashBankAccounts(rows: readonly AccountListRow[]): AccountListRow[] {
  return rows.filter((row) => row.isCashBank && row.isActive);
}

export interface AccountDetail extends AccountRow {
  lineCount: number;
  childCount: number;
  activeChildCount: number;
  mappingKeys: string[];
}

export async function getAccount(code: string, db: Database = defaultDb): Promise<AccountDetail | null> {
  if (!isAccountCode(code)) return null;
  const [row] = await db
    .select({
      ...accountColumns,
      lineCount: sql<number>`(select count(*) from ${journalLines} where ${q(journalLines, journalLines.accountCode)} = ${q(accounts, accounts.code)} or ${q(journalLines, journalLines.cashAccountCode)} = ${q(accounts, accounts.code)})::int`,
      childCount: sql<number>`(select count(*) from accounts child where child.parent_code = ${q(accounts, accounts.code)})::int`,
      activeChildCount: sql<number>`(select count(*) from accounts child where child.parent_code = ${q(accounts, accounts.code)} and child.is_active)::int`,
    })
    .from(accounts)
    .where(eq(accounts.code, code))
    .limit(1);
  if (!row) return null;
  const mappings = await db.select({ key: accountMappings.mappingKey }).from(accountMappings).where(eq(accountMappings.accountCode, code)).orderBy(asc(accountMappings.mappingKey));
  return { ...row, mappingKeys: mappings.map((mapping) => mapping.key) };
}

// ---------- Writes ----------

async function lockAccount(tx: Tx, code: string) {
  if (!isAccountCode(code)) return null;
  // NO KEY UPDATE: conflicts with the FOR SHARE the mapping and journal-line triggers take, so a
  // check made here can't be overtaken by a concurrent mapping or line on this account.
  const [row] = await tx.select().from(accounts).where(eq(accounts.code, code)).for("no key update");
  return row ?? null;
}

async function loadParent(tx: Tx, parentCode: string | null): Promise<ParentInfo | null> {
  if (parentCode === null) return null;
  if (!isAccountCode(parentCode)) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentNotFound);
  const [parent] = await tx
    .select({ code: accounts.code, type: accounts.type, isHeader: accounts.isHeader, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.code, parentCode))
    .for("share");
  if (!parent) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentNotFound);
  // A header is deactivated only after its sub-accounts; nothing new goes under an inactive one.
  if (!parent.isActive) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentInactive);
  return parent;
}

export interface CreateAccountInput extends NewAccountInput {
  parentCode: string | null;
}

/** A new account, never a system one (system accounts come only from migrations). Sorted right
 * after the account with the next-lower code, so reports that order by sort_order keep code order. */
export async function createAccount(input: CreateAccountInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const parent = await loadParent(tx, input.parentCode);
    const values = validateNewAccount(input, parent);
    const [previous] = await tx
      .select({ sortOrder: sql<number>`coalesce(max(${accounts.sortOrder}), 0)::int` })
      .from(accounts)
      .where(lt(accounts.code, values.code));
    try {
      const [created] = await tx
        .insert(accounts)
        .values({ ...values, parentCode: parent?.code ?? null, isSystem: false, systemKey: null, isActive: true, sortOrder: (previous?.sortOrder ?? 0) + 1 })
        .returning();
      if (!created) throw new Error("failed to insert account");
      await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "account", entityId: created.code, after: created });
      return created;
    } catch (error) {
      mapAccountError(error);
    }
  });
}

export interface UpdateAccountInput {
  name: string;
  parentCode: string | null;
  /** Read only where the accountant chooses it (not on a header, Kas & Bank or system account). */
  cashFlowGroup?: CashFlowGroup;
  bankName?: string | null;
  accountNoLast4?: string | null;
}

/** Name, parent, bank fields and (for an ordinary postable account) the cash-flow group. Code,
 * type and normal balance never change (accounts_guard_update), nor does the header switch here. */
export async function updateAccount(code: string, input: UpdateAccountInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await lockAccount(tx, code);
    if (!before) throw new ActionError(ACCOUNT_MESSAGES.notFound);
    const name = normalizeAccountName(input.name);
    const parentCode = input.parentCode || null;
    if (parentCode === before.code) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentCycle);
    const parent = await loadParent(tx, parentCode);
    assertValidParent(parent, before.type);
    const cashFlowGroup =
      before.isSystem || !cashFlowGroupIsChosen(before.code, before.isHeader)
        ? before.cashFlowGroup
        : resolveCashFlowGroup(before.code, before.isHeader, input.cashFlowGroup);
    // An omitted field keeps its value; an empty one clears it.
    const bank = normalizeBankFields(before.code, before.isHeader, {
      bankName: input.bankName === undefined ? before.bankName : input.bankName,
      accountNoLast4: input.accountNoLast4 === undefined ? before.accountNoLast4 : input.accountNoLast4,
    });
    try {
      const [after] = await tx.update(accounts).set({ name, parentCode, cashFlowGroup, ...bank }).where(eq(accounts.code, code)).returning();
      if (!after) throw new Error("failed to update account");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "account", entityId: code, before, after });
      return after;
    } catch (error) {
      mapAccountError(error);
    }
  });
}

/** "Nonaktifkan": hidden from new mappings and new journals; old journals keep it. Refused for a
 * system account, one a mapping points at (re-map first) and a header with active sub-accounts. */
export async function setAccountActive(code: string, isActive: boolean, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await lockAccount(tx, code);
    if (!before) throw new ActionError(ACCOUNT_MESSAGES.notFound);
    if (!isActive) {
      if (before.isSystem) throw new ActionError(ACCOUNT_MESSAGES.systemCannotDeactivate);
      const mapped = await tx.select({ key: accountMappings.mappingKey }).from(accountMappings).where(eq(accountMappings.accountCode, code));
      if (mapped.length > 0) throw new ActionError(ACCOUNT_MESSAGES.mappedCannotDeactivate);
      const [children] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(accounts)
        .where(and(eq(accounts.parentCode, code), eq(accounts.isActive, true)));
      if ((children?.count ?? 0) > 0) throw new ActionError(ACCOUNT_MESSAGES.headerWithActiveChildren);
    }
    if (isActive && before.parentCode !== null) {
      const [parent] = await tx.select({ isActive: accounts.isActive }).from(accounts).where(eq(accounts.code, before.parentCode)).for("share");
      if (parent && !parent.isActive) throw new ActionError(ACCOUNT_MESSAGES.parentInactive);
    }
    try {
      const [after] = await tx.update(accounts).set({ isActive }).where(eq(accounts.code, code)).returning();
      if (!after) throw new Error("failed to update account");
      await writeAuditLog(tx, { actorStaffUserId, action: isActive ? "activate" : "deactivate", entityType: "account", entityId: code, before, after });
      return after;
    } catch (error) {
      mapAccountError(error);
    }
  });
}

/** Only an account that was never used: not system, no journal line, no mapping, no sub-account
 * (a wrong code can only be fixed this way, since codes are immutable). accounts_guard_delete and
 * the FKs refuse the rest. */
export async function deleteAccount(code: string, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await lockAccount(tx, code);
    if (!before) throw new ActionError(ACCOUNT_MESSAGES.notFound);
    if (before.isSystem) throw new ActionError(ACCOUNT_MESSAGES.systemCannotDelete);
    try {
      await tx.delete(accounts).where(eq(accounts.code, code));
      await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "account", entityId: code, before });
    } catch (error) {
      mapAccountError(error);
    }
  });
}

/** The headers a (sub-)account may go under, each with the first free code beneath it. */
export function headerOptions(rows: readonly AccountListRow[], suggest: (parentCode: string, taken: ReadonlySet<string>) => string | null) {
  const taken = new Set(rows.map((row) => row.code));
  return rows
    .filter((row) => row.isHeader && row.isActive)
    .map((row) => ({ code: row.code, name: row.name, type: row.type, suggestedCode: suggest(row.code, taken) }));
}

import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { mappingFamily, mappingTargetProblem, type MappingTargetProblem } from "@ammari/accounting";
import { accountMappings, accounts, channels, expenseCategories, expenseItems, postingIssues, type AccountType, type ChannelId } from "@ammari/db/schema";
import { ActionError, FieldError, isPostgresErrorCode } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { PAYMENT_METHOD_MAPPING_LABELS } from "./labels";

// Pemetaan akun (docs/plans/accounting.md Session 3, §2.1, D-25): which account each expense
// category (and optionally each item), payment method and sales channel posts to. A missing key is a
// posting issue, never a guess (the engine reads account_mappings on every run, so a change here
// is picked up by the next run, which reverses and re-posts the journals it affects). Callers check
// accounting.view (reads) or accounting.view + accounting.manage (writes).
//
// The target rules are mappingTargetProblem (packages/accounting), applied under a FOR SHARE lock
// on the account for a clear message; account_mappings_guard_target (migration 0051) refuses the
// same in the database: above all, an expense never maps to an inventory account 1-15xx (D-14).

export const MAPPING_MESSAGES = {
  unknownKey: "Pemetaan ini tidak dikenal.",
  account: "Pilih akun.",
  categoryCannotBeCleared: "Kategori biaya harus selalu dipetakan ke satu akun.",
  targetProblem: {
    not_found: "Akun tidak ditemukan.",
    not_postable: "Akun tujuan harus aktif dan bukan akun kelompok.",
    inventory: "Biaya tidak boleh dipetakan ke akun persediaan (1-15xx). Bahan masuk persediaan hanya lewat penerimaan barang.",
    not_cash_bank: "Cara bayar hanya bisa dipetakan ke akun Kas & Bank (1-11xx, 1-12xx).",
    not_revenue: "Penjualan kanal hanya bisa dipetakan ke akun pendapatan.",
    not_liability: "Utang supplier hanya bisa dipetakan ke akun kewajiban.",
  } satisfies Record<MappingTargetProblem, string>,
} as const;

/** The mapping keys this editor writes (plan Session 3: expense categories and items, payment
 * methods, channels). supplier_payable.* stays as the migration set it. */
export const PAYMENT_METHOD_MAPPING_KEYS = ["cash.method.cash", "cash.method.transfer", "cash.method.card", "cash.midtrans_payout"] as const;

const ITEM_PREFIX = "expense.item.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MappingAccountOption {
  code: string;
  name: string;
  type: AccountType;
}

export interface MappingRow {
  mappingKey: string;
  label: string;
  /** Null: not mapped (an expense category then cannot be posted: D-25). */
  accountCode: string | null;
}

export interface CategoryMappingRow extends MappingRow {
  categoryCode: string;
  isActive: boolean;
  items: (MappingRow & { itemId: string; isActive: boolean })[];
}

export interface MappingPage {
  categories: CategoryMappingRow[];
  paymentMethods: MappingRow[];
  channels: MappingRow[];
  accounts: (MappingAccountOption & { isHeader: boolean; isActive: boolean })[];
}

export async function getMappingPage(db: Database = defaultDb): Promise<MappingPage> {
  const [mappingRows, categoryRows, itemRows, channelRows, accountRows] = await Promise.all([
    db.select({ key: accountMappings.mappingKey, code: accountMappings.accountCode }).from(accountMappings),
    db
      .select({ code: expenseCategories.code, name: sql<string>`${expenseCategories.name}::text`, isActive: expenseCategories.isActive })
      .from(expenseCategories)
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name)),
    db
      .select({ id: expenseItems.id, categoryCode: expenseItems.categoryCode, name: sql<string>`${expenseItems.name}::text`, isActive: expenseItems.isActive })
      .from(expenseItems)
      .orderBy(asc(expenseItems.sortOrder), asc(expenseItems.name)),
    db.select({ id: channels.id, name: channels.name }).from(channels).orderBy(asc(channels.id)),
    db
      .select({ code: accounts.code, name: sql<string>`${accounts.name}::text`, type: accounts.type, isHeader: accounts.isHeader, isActive: accounts.isActive })
      .from(accounts)
      .orderBy(asc(accounts.code)),
  ]);
  const mapped = new Map(mappingRows.map((row) => [row.key, row.code]));
  return {
    categories: categoryRows.map((category) => ({
      mappingKey: `expense.category.${category.code}`,
      label: category.name,
      accountCode: mapped.get(`expense.category.${category.code}`) ?? null,
      categoryCode: category.code,
      isActive: category.isActive,
      items: itemRows
        .filter((item) => item.categoryCode === category.code)
        .map((item) => ({
          mappingKey: `${ITEM_PREFIX}${item.id}`,
          label: item.name,
          accountCode: mapped.get(`${ITEM_PREFIX}${item.id}`) ?? null,
          itemId: item.id,
          isActive: item.isActive,
        })),
    })),
    paymentMethods: PAYMENT_METHOD_MAPPING_KEYS.map((key) => ({ mappingKey: key, label: PAYMENT_METHOD_MAPPING_LABELS[key] ?? key, accountCode: mapped.get(key) ?? null })),
    channels: channelRows.map((channel) => ({
      mappingKey: `revenue.channel.${channel.id}`,
      label: channel.name,
      accountCode: mapped.get(`revenue.channel.${channel.id}`) ?? null,
    })),
    accounts: accountRows,
  };
}

/** The accounts a key may point at (what the select offers); mappingTargetProblem decides. */
export function eligibleAccounts(mappingKey: string, rows: MappingPage["accounts"]): MappingAccountOption[] {
  return rows
    .filter((row) => mappingTargetProblem(mappingKey, row) === null)
    .map(({ code, name, type }) => ({ code, name, type }));
}

/** The key must name something that exists: an expense category or item, one of the payment
 * methods, or a channel. Anything else is refused (the editor never invents keys). */
async function assertKnownKey(db: Database, mappingKey: string): Promise<void> {
  const family = mappingFamily(mappingKey);
  let exists = false;
  if (family === "expense_category") {
    const code = mappingKey.slice("expense.category.".length);
    exists = (await db.select({ code: expenseCategories.code }).from(expenseCategories).where(eq(expenseCategories.code, code)).limit(1)).length > 0;
  } else if (family === "expense_item") {
    const id = mappingKey.slice(ITEM_PREFIX.length);
    exists = UUID.test(id) && (await db.select({ id: expenseItems.id }).from(expenseItems).where(eq(expenseItems.id, id)).limit(1)).length > 0;
  } else if (family === "cash_method" || family === "midtrans_payout") {
    exists = (PAYMENT_METHOD_MAPPING_KEYS as readonly string[]).includes(mappingKey);
  } else if (family === "revenue_channel") {
    const id = mappingKey.slice("revenue.channel.".length) as ChannelId;
    exists = (await db.select({ id: channels.id }).from(channels).where(eq(channels.id, id)).limit(1)).length > 0;
  }
  if (!exists) throw new ActionError(MAPPING_MESSAGES.unknownKey);
}

/** Points a key at an account (insert or change), audited. */
export async function setAccountMapping(mappingKey: string, accountCode: string, actorStaffUserId: string | null, db: Database = defaultDb) {
  await assertKnownKey(db, mappingKey);
  return db.transaction(async (tx) => {
    // FOR SHARE: a concurrent deactivation or header switch of the target waits for this write (and
    // then sees the mapping and is refused), or this read waits for it and sees its result.
    const [target] = await tx
      .select({ code: accounts.code, type: accounts.type, isHeader: accounts.isHeader, isActive: accounts.isActive })
      .from(accounts)
      .where(eq(accounts.code, accountCode))
      .for("share");
    const problem = mappingTargetProblem(mappingKey, target);
    if (problem) throw new FieldError("accountCode", MAPPING_MESSAGES.targetProblem[problem]);
    const [before] = await tx.select().from(accountMappings).where(eq(accountMappings.mappingKey, mappingKey)).for("update");
    if (before?.accountCode === accountCode) return before;
    try {
      // The UPDATE arm fires account_mappings_guard_target (UPDATE OF account_code), so an
      // existing key is re-checked against its new target by the database too.
      const [after] = await tx
        .insert(accountMappings)
        .values({ mappingKey, accountCode })
        .onConflictDoUpdate({ target: accountMappings.mappingKey, set: { accountCode } })
        .returning();
      if (!after) throw new Error("failed to write account mapping");
      await writeAuditLog(tx, { actorStaffUserId, action: "set", entityType: "account_mapping", entityId: mappingKey, before: before ?? null, after });
      return after;
    } catch (error) {
      // Only reached when a concurrent change slipped between the check above and the write: the
      // trigger's reason, in the editor's words.
      if (isPostgresErrorCode(error, "23514")) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const message = cause instanceof Error ? cause.message : "";
        const problem: MappingTargetProblem = /inventory/.test(message)
          ? "inventory"
          : /cash or bank/.test(message)
            ? "not_cash_bank"
            : /revenue account/.test(message)
              ? "not_revenue"
              : /liability account/.test(message)
                ? "not_liability"
                : "not_postable";
        throw new FieldError("accountCode", MAPPING_MESSAGES.targetProblem[problem]);
      }
      throw error;
    }
  });
}

/** Removes an item's override, so the item follows its category again. Only item keys: a category
 * must always be mapped (D-25), and the methods and channels always are. */
export async function clearItemMapping(itemId: string, actorStaffUserId: string | null, db: Database = defaultDb) {
  if (!UUID.test(itemId)) throw new ActionError(MAPPING_MESSAGES.unknownKey);
  const mappingKey = `${ITEM_PREFIX}${itemId}`;
  return db.transaction(async (tx) => {
    const [before] = await tx.delete(accountMappings).where(eq(accountMappings.mappingKey, mappingKey)).returning();
    if (before) await writeAuditLog(tx, { actorStaffUserId, action: "clear", entityType: "account_mapping", entityId: mappingKey, before });
  });
}

// ---------- Kategori Biaya warnings (D-25) ----------

export interface ExpenseMappingWarnings {
  /** Categories without a mapping: their expenses cannot be posted. */
  unmapped: { code: string; name: string }[];
  /** Open posting issues caused by a category's mapping (unmapped or onto inventory). */
  openIssueCount: number;
  /** category code → mapped account (code and name), for the category pages. */
  accountByCategory: Map<string, { code: string; name: string }>;
}

const EXPENSE_MAPPING_ISSUES = ["unmapped_expense_category", "expense_mapped_to_inventory"];

export async function getExpenseMappingWarnings(db: Database = defaultDb): Promise<ExpenseMappingWarnings> {
  const [rows, [issues]] = await Promise.all([
    db
      .select({
        code: expenseCategories.code,
        name: sql<string>`${expenseCategories.name}::text`,
        accountCode: accountMappings.accountCode,
        accountName: sql<string | null>`${accounts.name}::text`,
      })
      .from(expenseCategories)
      .leftJoin(accountMappings, eq(accountMappings.mappingKey, sql`'expense.category.' || ${expenseCategories.code}`))
      .leftJoin(accounts, eq(accounts.code, accountMappings.accountCode))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(postingIssues)
      .where(and(isNull(postingIssues.resolvedAt), inArray(postingIssues.issueCode, EXPENSE_MAPPING_ISSUES))),
  ]);
  const accountByCategory = new Map<string, { code: string; name: string }>();
  for (const row of rows) if (row.accountCode) accountByCategory.set(row.code, { code: row.accountCode, name: row.accountName ?? "" });
  return {
    unmapped: rows.filter((row) => row.accountCode === null).map((row) => ({ code: row.code, name: row.name })),
    openIssueCount: issues?.count ?? 0,
    accountByCategory,
  };
}

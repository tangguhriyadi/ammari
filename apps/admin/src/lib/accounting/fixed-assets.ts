import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { accumulatedAtDisposal, bookValueAt, depreciatedMonths, monthStartOf } from "@ammari/accounting";
import { accounts, fixedAssetGroups, fixedAssets, fixedAssetSettings } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import {
  FIXED_ASSET_MESSAGES,
  isAccumulatedDepreciationAccount,
  isCashBankAccount,
  isFixedAssetAccount,
  isFundingAccount,
  normalizeVoidReason,
  validateFixedAsset,
  validateFixedAssetDisposal,
  validateGroupInput,
  validateThresholdInput,
  type FixedAssetAccountInfo,
  type FixedAssetDisposalInput,
  type FixedAssetFormInput,
  type FixedAssetValidationContext,
} from "./fixed-asset-input";

// Aset tetap (docs/plans/accounting.md §5.3, D-19, Session 11): the register and its settings. Callers
// check accounting.view (reads) or accounting.view + accounting.manage (writes). Every write is one
// transaction with its audit_log row; the journals are not written here: the posting runner derives
// the acquisition, the monthly depreciation and the disposal from the row ("Posting sekarang", and
// the cron in Session 12), so an edit or a void is re-derived (reverse + repost, into the first open
// month when the original month is closed, D-23).

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FixedAssetStatus = "active" | "fully_depreciated" | "disposed" | "voided";

export interface FixedAssetListRow {
  id: string;
  name: string;
  groupCode: string;
  groupLabel: string;
  usefulLifeMonths: number;
  acquisitionDate: string;
  cost: number;
  assetAccountCode: string;
  assetAccountName: string;
  accumulatedAccountCode: string;
  fundingAccountCode: string | null;
  monthlyAmount: number;
  /** Per the schedule, through today (or the disposal). */
  accumulated: number;
  bookValue: number;
  status: FixedAssetStatus;
  disposedOn: string | null;
  disposalProceeds: number | null;
  voidReason: string | null;
}

export interface FixedAssetGroupRow {
  code: string;
  label: string;
  usefulLifeMonths: number;
}

export async function listFixedAssetGroups(db: Database = defaultDb): Promise<FixedAssetGroupRow[]> {
  return db
    .select({ code: fixedAssetGroups.code, label: fixedAssetGroups.label, usefulLifeMonths: fixedAssetGroups.usefulLifeMonths })
    .from(fixedAssetGroups)
    .orderBy(asc(fixedAssetGroups.sortOrder), asc(fixedAssetGroups.code));
}

export async function getCapitalizationThreshold(db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ amount: fixedAssetSettings.capitalizationThreshold }).from(fixedAssetSettings).where(eq(fixedAssetSettings.id, 1));
  // Shipped by migration 0055; missing means the database is not migrated.
  if (!row) throw new Error("fixed_asset_settings row 1 is missing (migration 0055)");
  return row.amount;
}

async function loadAccountInfo(db: Database): Promise<Map<string, FixedAssetAccountInfo>> {
  const rows = await db.select({ code: accounts.code, type: accounts.type, normalBalance: accounts.normalBalance, isActive: accounts.isActive, isHeader: accounts.isHeader }).from(accounts);
  return new Map(rows.map(({ code, ...info }) => [code, info]));
}

async function validationContext(db: Database, now: Date): Promise<FixedAssetValidationContext> {
  const [groups, capitalizationThreshold, accountInfo] = await Promise.all([listFixedAssetGroups(db), getCapitalizationThreshold(db), loadAccountInfo(db)]);
  return { today: todayInJakarta(now), groups: new Map(groups.map((group) => [group.code, group.usefulLifeMonths])), capitalizationThreshold, accounts: accountInfo };
}

export interface FixedAssetAccountChoice {
  code: string;
  name: string;
}

export interface FixedAssetFormChoices {
  groups: FixedAssetGroupRow[];
  capitalizationThreshold: number;
  assetAccounts: FixedAssetAccountChoice[];
  accumulatedAccounts: FixedAssetAccountChoice[];
  fundingAccounts: FixedAssetAccountChoice[];
  cashAccounts: FixedAssetAccountChoice[];
}

/** The pickers: active postable accounts of each kind, in chart order. */
export async function getFixedAssetFormChoices(db: Database = defaultDb): Promise<FixedAssetFormChoices> {
  const [groups, capitalizationThreshold, rows] = await Promise.all([
    listFixedAssetGroups(db),
    getCapitalizationThreshold(db),
    db
      .select({ code: accounts.code, name: sql<string>`${accounts.name}::text`, type: accounts.type, normalBalance: accounts.normalBalance, isActive: accounts.isActive, isHeader: accounts.isHeader })
      .from(accounts)
      .orderBy(asc(accounts.sortOrder), asc(accounts.code)),
  ]);
  const pick = (test: (code: string, info: FixedAssetAccountInfo) => boolean) => rows.filter((row) => test(row.code, row)).map(({ code, name }) => ({ code, name }));
  return {
    groups,
    capitalizationThreshold,
    assetAccounts: pick(isFixedAssetAccount),
    accumulatedAccounts: pick(isAccumulatedDepreciationAccount),
    fundingAccounts: pick(isFundingAccount),
    cashAccounts: pick(isCashBankAccount),
  };
}

function statusOf(row: { voidedAt: Date | null; disposedOn: string | null; cost: number; usefulLifeMonths: number; acquisitionDate: string }, today: string): FixedAssetStatus {
  if (row.voidedAt) return "voided";
  if (row.disposedOn && row.disposedOn <= today) return "disposed";
  const last = depreciatedMonths({ ...row, disposedOn: null }).at(-1);
  return last && last.month <= monthStartOf(today) ? "fully_depreciated" : "active";
}

export async function listFixedAssets(db: Database = defaultDb, now: Date = new Date(), onlyId?: string): Promise<FixedAssetListRow[]> {
  const today = todayInJakarta(now);
  const assetAccount = alias(accounts, "asset_account");
  const rows = await db
    .select({
      id: fixedAssets.id,
      name: fixedAssets.name,
      groupCode: fixedAssets.groupCode,
      groupLabel: fixedAssetGroups.label,
      usefulLifeMonths: fixedAssets.usefulLifeMonths,
      acquisitionDate: fixedAssets.acquisitionDate,
      cost: fixedAssets.cost,
      assetAccountCode: fixedAssets.assetAccountCode,
      assetAccountName: sql<string>`${assetAccount.name}::text`,
      accumulatedAccountCode: fixedAssets.accumulatedAccountCode,
      fundingAccountCode: fixedAssets.fundingAccountCode,
      disposedOn: fixedAssets.disposedOn,
      disposalProceeds: fixedAssets.disposalProceeds,
      voidedAt: fixedAssets.voidedAt,
      voidReason: fixedAssets.voidReason,
    })
    .from(fixedAssets)
    .innerJoin(fixedAssetGroups, eq(fixedAssetGroups.code, fixedAssets.groupCode))
    .innerJoin(assetAccount, eq(assetAccount.code, fixedAssets.assetAccountCode))
    .where(onlyId ? eq(fixedAssets.id, onlyId) : undefined)
    .orderBy(asc(fixedAssets.acquisitionDate), asc(fixedAssets.createdAt), asc(fixedAssets.id));
  return rows.map(({ voidedAt, ...row }) => {
    const status = statusOf({ ...row, voidedAt }, today);
    const accumulated = row.disposedOn && row.disposedOn <= today ? accumulatedAtDisposal(row) : row.cost - bookValueAt({ ...row, disposedOn: null }, today);
    return {
      ...row,
      monthlyAmount: Math.floor(row.cost / row.usefulLifeMonths),
      accumulated: status === "voided" ? 0 : accumulated,
      bookValue: status === "voided" || status === "disposed" ? 0 : row.cost - accumulated,
      status,
    };
  });
}

export type FixedAssetRow = typeof fixedAssets.$inferSelect;

export async function getFixedAsset(id: string, db: Database = defaultDb): Promise<FixedAssetRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const [row] = await db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).limit(1);
  return row ?? null;
}

/** "Catat aset tetap". */
export async function createFixedAsset(input: FixedAssetFormInput, actorStaffUserId: string, db: Database = defaultDb, now: Date = new Date()) {
  return db.transaction(async (tx) => {
    const values = validateFixedAsset(input, await validationContext(tx, now));
    const [created] = await tx.insert(fixedAssets).values({ ...values, createdByStaffUserId: actorStaffUserId, updatedByStaffUserId: actorStaffUserId }).returning();
    if (!created) throw new Error("failed to insert fixed asset");
    await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "fixed_asset", entityId: created.id, after: created });
    return created;
  });
}

async function lockAsset(tx: Database, id: string): Promise<FixedAssetRow> {
  const [row] = UUID_PATTERN.test(id) ? await tx.select().from(fixedAssets).where(eq(fixedAssets.id, id)).for("update") : [];
  if (!row) throw new ActionError(FIXED_ASSET_MESSAGES.notFound);
  if (row.voidedAt) throw new ActionError(FIXED_ASSET_MESSAGES.voided);
  return row;
}

/** "Ubah": every field. The useful life is re-copied from the group only when the group changes, so
 * an edit of the group's months never re-writes an existing schedule. */
export async function updateFixedAsset(id: string, input: FixedAssetFormInput, actorStaffUserId: string, db: Database = defaultDb, now: Date = new Date()) {
  return db.transaction(async (tx) => {
    const before = await lockAsset(tx, id);
    if (before.disposedOn) throw new ActionError(FIXED_ASSET_MESSAGES.disposed);
    const values = validateFixedAsset(input, await validationContext(tx, now), before.cost);
    const usefulLifeMonths = values.groupCode === before.groupCode ? before.usefulLifeMonths : values.usefulLifeMonths;
    const [after] = await tx
      .update(fixedAssets)
      .set({ ...values, usefulLifeMonths, updatedByStaffUserId: actorStaffUserId })
      .where(eq(fixedAssets.id, before.id))
      .returning();
    if (!after) throw new Error("failed to update fixed asset");
    await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "fixed_asset", entityId: before.id, before, after });
    return after;
  });
}

/** "Lepas aset" (sold or scrapped). */
export async function disposeFixedAsset(id: string, input: FixedAssetDisposalInput, actorStaffUserId: string, db: Database = defaultDb, now: Date = new Date()) {
  return db.transaction(async (tx) => {
    const before = await lockAsset(tx, id);
    if (before.disposedOn) throw new ActionError(FIXED_ASSET_MESSAGES.disposed);
    const values = validateFixedAssetDisposal(input, { today: todayInJakarta(now), acquisitionDate: before.acquisitionDate, accounts: await loadAccountInfo(tx) });
    const [after] = await tx.update(fixedAssets).set({ ...values, updatedByStaffUserId: actorStaffUserId }).where(eq(fixedAssets.id, before.id)).returning();
    if (!after) throw new Error("failed to dispose fixed asset");
    await writeAuditLog(tx, { actorStaffUserId, action: "dispose", entityType: "fixed_asset", entityId: before.id, before, after });
    return after;
  });
}

/** "Batalkan" a wrongly registered asset (written reason). Final: the 0055 trigger refuses any later
 * change. The next posting run reverses every journal the asset produced. */
export async function voidFixedAsset(id: string, reason: string, actorStaffUserId: string, db: Database = defaultDb, now: Date = new Date()) {
  const voidReason = normalizeVoidReason(reason);
  return db.transaction(async (tx) => {
    const before = await lockAsset(tx, id);
    const [after] = await tx.update(fixedAssets).set({ voidedAt: now, voidReason, updatedByStaffUserId: actorStaffUserId }).where(eq(fixedAssets.id, before.id)).returning();
    if (!after) throw new Error("failed to void fixed asset");
    await writeAuditLog(tx, { actorStaffUserId, action: "void", entityType: "fixed_asset", entityId: before.id, before, after });
    return after;
  });
}

/** A tax group's name and useful life (D-19: a setting, not a constant). Applies to assets saved
 * from now on; existing assets keep the months they were saved with. */
export async function updateFixedAssetGroup(code: string, input: { label: string; usefulLifeMonths: string }, actorStaffUserId: string, db: Database = defaultDb) {
  const values = validateGroupInput(input);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(fixedAssetGroups).where(eq(fixedAssetGroups.code, code)).for("update");
    if (!before) throw new ActionError(FIXED_ASSET_MESSAGES.group);
    const [after] = await tx.update(fixedAssetGroups).set({ ...values, updatedByStaffUserId: actorStaffUserId }).where(eq(fixedAssetGroups.code, code)).returning();
    if (!after) throw new Error("failed to update fixed asset group");
    await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "fixed_asset_group", entityId: code, before, after });
    return after;
  });
}

/** The capitalisation threshold (D-19: Rp1.000.000, a setting). Checked when an asset is saved. */
export async function updateCapitalizationThreshold(raw: string, actorStaffUserId: string, db: Database = defaultDb) {
  const capitalizationThreshold = validateThresholdInput(raw);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(fixedAssetSettings).where(eq(fixedAssetSettings.id, 1)).for("update");
    if (!before) throw new Error("fixed_asset_settings row 1 is missing (migration 0055)");
    const [after] = await tx.update(fixedAssetSettings).set({ capitalizationThreshold, updatedByStaffUserId: actorStaffUserId }).where(eq(fixedAssetSettings.id, 1)).returning();
    if (!after) throw new Error("failed to update fixed asset settings");
    await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "fixed_asset_settings", entityId: "1", before, after });
    return after;
  });
}

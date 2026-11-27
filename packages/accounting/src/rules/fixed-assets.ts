import { monthEndOf, monthStartOf, nextMonthStart } from "../dates";
import type { JournalLineDraft } from "../journal";
import { mappedAccount, resolveOrIssue, systemAccount, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// Fixed assets and depreciation (docs/plans/accounting.md §5.3, Session 11, D-19). One register row
// (fixed_assets, migration 0055) per snapshot; every journal is derived from it, so an edit or a void
// is re-derived by the runner (reverse + repost, into the first open month when the original month
// is closed, D-23).
//
//   acquired  (fixed_asset, id, acquired), acquisition_date: Dr the asset account / Cr the funding
//             account (Kas & Bank, or a liability when bought on credit), cost. No funding account =
//             the purchase is already in the books (opening balance or another journal): nothing.
//   dep:YYYY-MM (fixed_asset, id, dep:YYYY-MM), the month's last day, kind `depreciation`: Dr 6-2401
//             Beban penyusutan (system key expense.depreciation) / Cr the asset's Akumulasi penyusutan.
//             Straight line from the ACQUISITION month (D-19), zero residual: floor(cost / life) each
//             month, the last month of the life absorbs the rounding, so the months sum to the cost.
//             A month is posted once it has started (the current month is posted ahead, dated its last
//             day, so it shows in reports only from that day). A disposed asset is not depreciated in
//             its disposal month or after (the first month counts in full, the disposal month not).
//   disposed  (fixed_asset, id, disposed), disposed_on: Dr Kas & Bank the proceeds · Dr Akumulasi the
//             depreciation of the months before the disposal month (also those before the books,
//             which the opening balance carries) / Cr the asset account, cost; the rest to the mapping
//             `fixed_asset.disposal_result` (8-1102 Rugi pelepasan aset tetap; a gain credits it).
//
// Events dated before the posting start are never posted (the opening balance holds them). A void
// makes every key "none", so the runner reverses whatever was posted.

export const FIXED_ASSET_SOURCE_TYPE = "fixed_asset";
export const FIXED_ASSET_RULE_VERSION = 1;

export interface FixedAssetSnapshot {
  id: string;
  name: string;
  usefulLifeMonths: number;
  /** Jakarta calendar day. */
  acquisitionDate: string;
  cost: number;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  fundingAccountCode: string | null;
  disposedOn: string | null;
  disposalProceeds: number | null;
  disposalCashAccountCode: string | null;
  voided: boolean;
  /** The current Jakarta month's first day: months after it are not posted yet. */
  asOfMonth: string;
}

export interface DepreciationMonth {
  /** First day of the month. */
  month: string;
  /** 1-based position in the life. */
  index: number;
  amount: number;
}

/** The full straight-line schedule (D-19): `life` months from the acquisition month, floor(cost /
 * life) each, the last month takes the rounding rest. Zero residual: the amounts sum to `cost`. */
export function depreciationSchedule(cost: number, usefulLifeMonths: number, acquisitionDate: string): DepreciationMonth[] {
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error(`invalid cost ${cost}`);
  if (!Number.isSafeInteger(usefulLifeMonths) || usefulLifeMonths < 1) throw new Error(`invalid useful life ${usefulLifeMonths}`);
  const base = Math.floor(cost / usefulLifeMonths);
  const schedule: DepreciationMonth[] = [];
  let month = monthStartOf(acquisitionDate);
  for (let index = 1; index <= usefulLifeMonths; index += 1) {
    schedule.push({ month, index, amount: index === usefulLifeMonths ? cost - base * (usefulLifeMonths - 1) : base });
    month = nextMonthStart(month);
  }
  return schedule;
}

/** The schedule months the asset is depreciated in: every month before the disposal month. */
export function depreciatedMonths(asset: Pick<FixedAssetSnapshot, "cost" | "usefulLifeMonths" | "acquisitionDate" | "disposedOn">): DepreciationMonth[] {
  const schedule = depreciationSchedule(asset.cost, asset.usefulLifeMonths, asset.acquisitionDate);
  if (!asset.disposedOn) return schedule;
  const disposalMonth = monthStartOf(asset.disposedOn);
  return schedule.filter((entry) => entry.month < disposalMonth);
}

/** Akumulasi penyusutan at the disposal: the depreciation of every month before the disposal month. */
export function accumulatedAtDisposal(asset: Pick<FixedAssetSnapshot, "cost" | "usefulLifeMonths" | "acquisitionDate" | "disposedOn">): number {
  return depreciatedMonths(asset).reduce((sum, entry) => sum + entry.amount, 0);
}

/** Book value (cost − accumulated depreciation) at the end of `month`'s last day, from the schedule. */
export function bookValueAt(asset: Pick<FixedAssetSnapshot, "cost" | "usefulLifeMonths" | "acquisitionDate" | "disposedOn">, date: string): number {
  if (asset.disposedOn && asset.disposedOn <= date) return 0;
  const through = monthStartOf(date);
  return asset.cost - depreciatedMonths(asset).filter((entry) => entry.month <= through).reduce((sum, entry) => sum + entry.amount, 0);
}

export const depreciationEvent = (month: string) => `dep:${month.slice(0, 7)}`;

function line(accountCode: string, debit: number, credit: number, memo?: string): JournalLineDraft {
  return { accountCode, debit, credit, ...(memo ? { memo } : {}) };
}

function acquisitionOutcome(asset: FixedAssetSnapshot): PostingOutcome {
  if (!asset.fundingAccountCode) return { kind: "none" };
  return {
    kind: "journal",
    description: `Perolehan aset tetap ${asset.name}`,
    lines: [line(asset.assetAccountCode, asset.cost, 0), line(asset.fundingAccountCode, 0, asset.cost)].map((l) =>
      l.accountCode === asset.fundingAccountCode && /^1-1[12]/.test(l.accountCode) ? { ...l, cashAccountCode: l.accountCode } : l,
    ),
  };
}

function depreciationOutcome(asset: FixedAssetSnapshot, entry: DepreciationMonth, context: PostingContext): PostingOutcome {
  if (entry.amount === 0) return { kind: "none" };
  return resolveOrIssue(() => ({
    kind: "journal",
    description: `Penyusutan ${asset.name} ${entry.month.slice(0, 7)} (bulan ke-${entry.index} dari ${asset.usefulLifeMonths})`,
    lines: [line(systemAccount(context, "expense.depreciation"), entry.amount, 0), line(asset.accumulatedAccountCode, 0, entry.amount)],
  }));
}

function disposalOutcome(asset: FixedAssetSnapshot, context: PostingContext): PostingOutcome {
  const proceeds = asset.disposalProceeds ?? 0;
  const accumulated = accumulatedAtDisposal(asset);
  // proceeds + accumulated + loss = cost (a negative loss is a gain).
  const loss = asset.cost - accumulated - proceeds;
  return resolveOrIssue(() => {
    const result = loss === 0 ? null : mappedAccount(context, "fixed_asset.disposal_result", "unmapped_fixed_asset_disposal");
    const lines: JournalLineDraft[] = [];
    if (proceeds > 0 && asset.disposalCashAccountCode) lines.push({ ...line(asset.disposalCashAccountCode, proceeds, 0), cashAccountCode: asset.disposalCashAccountCode });
    if (accumulated > 0) lines.push(line(asset.accumulatedAccountCode, accumulated, 0));
    if (result && loss > 0) lines.push(line(result, loss, 0, "Rugi pelepasan"));
    lines.push(line(asset.assetAccountCode, 0, asset.cost));
    if (result && loss < 0) lines.push(line(result, 0, -loss, "Laba pelepasan"));
    return { kind: "journal", description: `Pelepasan aset tetap ${asset.name}`, lines };
  });
}

export function fixedAssetEvents(asset: FixedAssetSnapshot, context: PostingContext): PostingEvent[] {
  const key = (sourceEvent: string) => ({ sourceType: FIXED_ASSET_SOURCE_TYPE, sourceId: asset.id, sourceEvent });
  const before = (date: string) => date < context.postingStartDate;
  const events: PostingEvent[] = [];

  events.push({
    key: key("acquired"),
    sourceDate: asset.acquisitionDate,
    outcome: asset.voided || before(asset.acquisitionDate) ? { kind: "none" } : acquisitionOutcome(asset),
  });

  // Every month of the life is emitted, plus every month from the posting start through the current
  // month (most as "none"): a posted month always lies in that window, so a shortened life, a later
  // acquisition date, a disposal or a void reverses months that were posted before.
  const schedule = new Map(depreciationSchedule(asset.cost, asset.usefulLifeMonths, asset.acquisitionDate).map((entry) => [entry.month, entry]));
  const depreciated = new Set(depreciatedMonths(asset).map((entry) => entry.month));
  const months = new Set(schedule.keys());
  for (let month = monthStartOf(context.postingStartDate); month <= asset.asOfMonth; month = nextMonthStart(month)) months.add(month);
  for (const month of [...months].sort()) {
    const entry = schedule.get(month);
    const date = monthEndOf(month);
    const posts = !!entry && !asset.voided && depreciated.has(month) && !before(date) && month <= asset.asOfMonth;
    events.push({
      key: key(depreciationEvent(month)),
      sourceDate: date,
      outcome: posts && entry ? depreciationOutcome(asset, entry, context) : { kind: "none" },
      entryKind: "depreciation",
    });
  }

  events.push({
    key: key("disposed"),
    sourceDate: asset.disposedOn ?? asset.acquisitionDate,
    outcome: asset.voided || !asset.disposedOn || before(asset.disposedOn) ? { kind: "none" } : disposalOutcome(asset, context),
  });
  return events;
}

export const fixedAssetRule: PostingRule<FixedAssetSnapshot> = {
  name: "fixed_asset",
  ruleVersion: FIXED_ASSET_RULE_VERSION,
  events: fixedAssetEvents,
};

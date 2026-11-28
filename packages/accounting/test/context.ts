import { CHART_OF_ACCOUNTS, DEFAULT_ACCOUNT_MAPPINGS, FIXED_ASSET_ACCOUNT_MAPPINGS, TIKTOK_ACCOUNT_MAPPINGS } from "@ammari/db/accounting";
import type { AccountInfo, PostingContext } from "../src/rules/types";

/** A PostingContext built from the shipped chart of accounts and default mappings (migration
 * 0049, plus the fixed asset mapping of 0055 and TikTok's payout mapping of 0062), as the runner would load it from a fresh database. */
export function defaultContext(overrides: { mappings?: Record<string, string | null>; postingStartDate?: string } = {}): PostingContext {
  const mappings = new Map([...DEFAULT_ACCOUNT_MAPPINGS, ...FIXED_ASSET_ACCOUNT_MAPPINGS, ...TIKTOK_ACCOUNT_MAPPINGS].map((row) => [row.mappingKey, row.accountCode]));
  for (const [key, code] of Object.entries(overrides.mappings ?? {})) {
    if (code === null) mappings.delete(key);
    else mappings.set(key, code);
  }
  const accounts = new Map<string, AccountInfo>(CHART_OF_ACCOUNTS.map((row) => [row.code, { type: row.type, isActive: true, isHeader: row.isHeader }]));
  const systemAccounts = new Map(CHART_OF_ACCOUNTS.filter((row) => row.systemKey).map((row) => [row.systemKey as string, row.code]));
  return { mappings, accounts, systemAccounts, postingStartDate: overrides.postingStartDate ?? "2026-12-01" };
}

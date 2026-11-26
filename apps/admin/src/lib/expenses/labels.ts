import type { BusinessExpenseMethod, ChannelId, DefaultExpenseCategoryCode, ExpenseCategoryKind } from "@ammari/db/schema";

// Indonesian labels for the "Iklan" and "Biaya" menus (docs/plans/growth.md §3.1). No server dependency, so the
// record dialog and the list share them. Category NAMES are not here: since migration 0048 they
// are expense_categories rows (lib/expense-categories), so a rename shows everywhere.

/** The two groups of the category picker and the list filter, in display order. A category's
 * group follows from its kind (docs/plans/expense-master-data.md §3.1), so a new ad category the
 * owner creates lands under "Iklan" without a code change. */
export const EXPENSE_CATEGORY_GROUPS = [
  { key: "marketing", label: "Iklan", kinds: ["ad", "endorsement"] },
  { key: "operational", label: "Operasional", kinds: ["operating"] },
] as const satisfies readonly { key: string; label: string; kinds: readonly ExpenseCategoryKind[] }[];

export type ExpenseCategoryGroup = (typeof EXPENSE_CATEGORY_GROUPS)[number]["key"];

/** The group keys, for a zod enum (the record form posts its menu's group). */
export const EXPENSE_CATEGORY_GROUP_KEYS = ["marketing", "operational"] as const satisfies readonly ExpenseCategoryGroup[];

/** A category posted from the wrong menu (a stale page, or a hand-made request). */
export const EXPENSE_SCOPE_MESSAGES: Record<ExpenseCategoryGroup, string> = {
  marketing: "Kategori ini bukan iklan atau endorse. Catat di menu Biaya.",
  operational: "Kategori ini termasuk iklan atau endorse. Catat di menu Iklan.",
};

/** Field hints that keep a cost from being counted twice (plan §4.3). Keyed by the seeded codes
 * (expense-master-data.md §3.2); any other category simply has no hint. */
export const EXPENSE_CATEGORY_HINTS: Partial<Record<DefaultExpenseCategoryCode, string>> = {
  material_shipping: "Hanya ongkir yang tidak tercatat di dokumen pembelian. Ongkir di pembelian sudah masuk HPP.",
  endorsement: "Komisi affiliate Shopee/TikTok sudah masuk dari impor sebagai biaya platform. Jangan dicatat lagi di sini.",
  other: "Tulis di catatan biaya apa ini.",
};

export function expenseCategoryHint(code: string): string | undefined {
  return Object.hasOwn(EXPENSE_CATEGORY_HINTS, code) ? EXPENSE_CATEGORY_HINTS[code as DefaultExpenseCategoryCode] : undefined;
}

export const EXPENSE_METHOD_LABELS: Record<BusinessExpenseMethod, string> = {
  transfer: "Transfer",
  cash: "Tunai",
  card: "Kartu",
  platform_balance: "Saldo platform",
};

/** The channels an ad or endorse can be tagged with (owner answer Q14), in display order. */
export const MARKETING_CHANNEL_OPTIONS = ["shopee", "tiktok", "web", "instagram", "whatsapp"] as const satisfies readonly ChannelId[];
export type MarketingChannelId = (typeof MARKETING_CHANNEL_OPTIONS)[number];

export const MARKETING_CHANNEL_LABELS: Record<MarketingChannelId, string> = {
  shopee: "Shopee",
  tiktok: "TikTok Shop",
  web: "Situs",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};

/** "Gaji", "Gaji dan Sewa", "Gaji, Sewa, dan Utilitas": category names as an Indonesian list. */
export function joinCategoryLabels(labels: readonly string[]): string {
  if (labels.length <= 2) return labels.join(" dan ");
  return `${labels.slice(0, -1).join(", ")}, dan ${labels.at(-1)}`;
}

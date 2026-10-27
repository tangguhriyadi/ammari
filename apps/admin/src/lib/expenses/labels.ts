import type { BusinessExpenseCategory, BusinessExpenseMethod, ChannelId } from "@ammari/db/schema";

// Indonesian labels for "Iklan & Biaya" (docs/plans/growth.md §3.1). No server dependency, so the
// record dialog and the list share them. The keys live in @ammari/db's constants (CHECK-backed).

export const EXPENSE_CATEGORY_LABELS: Record<BusinessExpenseCategory, string> = {
  ads_meta: "Iklan Meta",
  ads_tiktok: "Iklan TikTok",
  ads_shopee: "Iklan Shopee",
  endorsement: "Endorse/KOL",
  material_shipping: "Ongkir bahan",
  packaging: "Packaging",
  salary: "Gaji",
  rent: "Sewa",
  utilities: "Utilitas",
  other: "Lainnya",
};

/** The two groups of the category picker and the list filter, in display order. */
export const EXPENSE_CATEGORY_GROUPS = [
  { key: "marketing", label: "Iklan", categories: ["ads_meta", "ads_tiktok", "ads_shopee", "endorsement"] },
  { key: "operational", label: "Operasional", categories: ["material_shipping", "packaging", "salary", "rent", "utilities", "other"] },
] as const satisfies readonly { key: string; label: string; categories: readonly BusinessExpenseCategory[] }[];

export type ExpenseCategoryGroup = (typeof EXPENSE_CATEGORY_GROUPS)[number]["key"];

/** Field hints that keep a cost from being counted twice (plan §4.3). */
export const EXPENSE_CATEGORY_HINTS: Partial<Record<BusinessExpenseCategory, string>> = {
  material_shipping: "Hanya ongkir yang tidak tercatat di dokumen pembelian. Ongkir di pembelian sudah masuk HPP.",
  endorsement: "Komisi affiliate Shopee/TikTok sudah masuk dari impor sebagai biaya platform. Jangan dicatat lagi di sini.",
  other: "Tulis di catatan biaya apa ini.",
};

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

/** "Pengingat biaya bulanan" (docs/plans/growth.md §6, owner answer A6): the categories /settings
 * offers as "must be recorded every month", in display order. Any fixed category may be added
 * here later (the DB CHECK allows the whole list); none is chosen by default (reminder off). */
export const MONTHLY_BILL_CATEGORY_OPTIONS = ["salary", "rent", "utilities"] as const satisfies readonly BusinessExpenseCategory[];
export type MonthlyBillCategory = (typeof MONTHLY_BILL_CATEGORY_OPTIONS)[number];

/** "Gaji", "Gaji dan Sewa", "Gaji, Sewa, dan Utilitas". */
export function joinCategoryLabels(categories: readonly BusinessExpenseCategory[]): string {
  const labels = categories.map((category) => EXPENSE_CATEGORY_LABELS[category]);
  if (labels.length <= 2) return labels.join(" dan ");
  return `${labels.slice(0, -1).join(", ")}, dan ${labels.at(-1)}`;
}

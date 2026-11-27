import type { AccountNormalBalance, AccountType, CashFlowGroup, ChannelId, DefaultExpenseCategoryCode, TaxpayerType } from "../schema/constants";

// The initial Chart of Accounts (SAK EMKM style), account mappings and PPh final setting
// (docs/plans/accounting.md §3, §2.1; decisions D-1..D-25 in docs/plans/accounting-decisions.md).
//
// Reference data the posting rules match by literal (system_key, mapping_key), so it ships in
// migration 0049 (INSERT ... ON CONFLICT DO NOTHING, CLAUDE.md DB rule); seed.ts repeats it
// insert-only for test/e2e databases reset by TRUNCATE. migration-0049.test.ts asserts the
// migration's rows equal these constants exactly. After go-live the accountant owns the rows
// (rename, add sub-accounts, deactivate non-system ones): nothing here ever overwrites them.
//
// Account names are UI text (Indonesian, no dashes as separators).

export interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: AccountNormalBalance;
  parentCode: string | null;
  isHeader: boolean;
  /** Set only on system-locked accounts (the lock mark in plan §3): a posting rule finds the account by this
   * key, so it can be renamed and get sub-accounts but never be deactivated or deleted. */
  systemKey: string | null;
  cashFlowGroup: CashFlowGroup;
  sortOrder: number;
}

type Row = [
  code: string,
  name: string,
  type: AccountType,
  parentCode: string | null,
  options?: { header?: boolean; systemKey?: string; cashFlow?: CashFlowGroup; normalBalance?: AccountNormalBalance },
];

/** Debit-normal types; everything else is credit-normal unless a row says otherwise (contra
 * accounts: Akumulasi penyusutan is a credit-normal asset, Prive a debit-normal equity). */
const DEBIT_NORMAL: readonly AccountType[] = ["asset", "contra_revenue", "cogs", "expense", "other_expense", "tax"];

const ROWS: readonly Row[] = [
  // 1 ASET
  ["1-1000", "Aset lancar", "asset", null, { header: true }],
  ["1-1100", "Kas", "asset", "1-1000", { header: true }],
  ["1-1101", "Kas tunai", "asset", "1-1100", { systemKey: "cash.on_hand", cashFlow: "cash" }],
  ["1-1200", "Bank", "asset", "1-1000", { header: true }],
  ["1-1201", "Bank utama", "asset", "1-1200", { systemKey: "bank.main", cashFlow: "cash" }],
  ["1-1300", "Saldo pembayaran & marketplace", "asset", "1-1000", { header: true }],
  ["1-1301", "Piutang Midtrans", "asset", "1-1300", { systemKey: "receivable.midtrans" }],
  ["1-1302", "Saldo Penjual Shopee", "asset", "1-1300", { systemKey: "seller_balance.shopee" }],
  ["1-1303", "Saldo Penjual TikTok", "asset", "1-1300", { systemKey: "seller_balance.tiktok" }],
  ["1-1305", "Saldo marketplace belum dipilah", "asset", "1-1300", { systemKey: "seller_balance.unallocated" }],
  ["1-1400", "Piutang", "asset", "1-1000", { header: true }],
  ["1-1402", "Piutang klaim pemasok (lebih bayar)", "asset", "1-1400", { systemKey: "receivable.supplier_claim" }],
  ["1-1409", "Piutang lain-lain", "asset", "1-1400"],
  ["1-1500", "Persediaan", "asset", "1-1000", { header: true }],
  ["1-1501", "Persediaan bahan kain", "asset", "1-1500", { systemKey: "inventory.fabric" }],
  ["1-1502", "Persediaan aksesoris", "asset", "1-1500", { systemKey: "inventory.accessory" }],
  ["1-1503", "Barang dalam proses (produksi)", "asset", "1-1500", { systemKey: "inventory.wip" }],
  ["1-1504", "Persediaan barang jadi", "asset", "1-1500", { systemKey: "inventory.finished_goods" }],
  ["1-1505", "Barang terjual belum dikirim", "asset", "1-1500", { systemKey: "inventory.sold_not_shipped" }],
  ["1-1506", "Persediaan barang cacat", "asset", "1-1500", { systemKey: "inventory.defect" }],
  ["1-1600", "Uang muka & dibayar di muka", "asset", "1-1000", { header: true }],
  ["1-1601", "Uang muka pembelian", "asset", "1-1600", { systemKey: "prepaid.purchase_advance" }],
  ["1-1602", "Sewa dibayar di muka", "asset", "1-1600"],
  ["1-1603", "Saldo Biteship (uang muka ongkir)", "asset", "1-1600", { systemKey: "prepaid.biteship" }],
  ["1-2000", "Aset tetap", "asset", null, { header: true }],
  ["1-2101", "Mesin & peralatan produksi", "asset", "1-2000", { cashFlow: "investing" }],
  ["1-2102", "Peralatan kantor & komputer", "asset", "1-2000", { cashFlow: "investing" }],
  ["1-2103", "Kendaraan", "asset", "1-2000", { cashFlow: "investing" }],
  ["1-2104", "Bangunan/renovasi", "asset", "1-2000", { cashFlow: "investing" }],
  ["1-2191", "Akumulasi penyusutan mesin & peralatan produksi", "asset", "1-2000", { cashFlow: "investing", normalBalance: "credit" }],
  ["1-2192", "Akumulasi penyusutan peralatan kantor & komputer", "asset", "1-2000", { cashFlow: "investing", normalBalance: "credit" }],
  ["1-2193", "Akumulasi penyusutan kendaraan", "asset", "1-2000", { cashFlow: "investing", normalBalance: "credit" }],
  ["1-2194", "Akumulasi penyusutan bangunan/renovasi", "asset", "1-2000", { cashFlow: "investing", normalBalance: "credit" }],

  // 2 KEWAJIBAN
  ["2-1101", "Utang usaha pemasok bahan", "liability", null, { systemKey: "payable.material_supplier" }],
  ["2-1102", "Utang usaha jasa produksi", "liability", null, { systemKey: "payable.production_service" }],
  ["2-1103", "Utang usaha tanpa pemasok", "liability", null, { systemKey: "payable.no_supplier" }],
  ["2-1201", "Uang muka pelanggan", "liability", null, { systemKey: "liability.customer_deposit" }],
  ["2-1202", "Utang pengembalian dana pelanggan", "liability", null, { systemKey: "liability.customer_refund" }],
  ["2-1203", "Titipan ongkir pembeli", "liability", null, { systemKey: "liability.buyer_shipping" }],
  ["2-1401", "Utang PPh final", "liability", null, { systemKey: "liability.pph_final" }],
  ["2-1402", "Biaya masih harus dibayar", "liability", null],
  ["2-2101", "Utang bank/pinjaman", "liability", null, { cashFlow: "financing" }],
  ["2-2201", "Pinjaman dari pemilik", "liability", null, { cashFlow: "financing" }],

  // 3 EKUITAS
  ["3-1001", "Modal pemilik", "equity", null, { systemKey: "equity.owner_capital", cashFlow: "financing" }],
  ["3-1002", "Prive", "equity", null, { systemKey: "equity.drawings", cashFlow: "financing", normalBalance: "debit" }],
  ["3-2001", "Saldo laba", "equity", null, { systemKey: "equity.retained_earnings", cashFlow: "none" }],
  ["3-2002", "Laba (rugi) tahun berjalan", "equity", null, { systemKey: "equity.current_year_earnings", cashFlow: "none" }],
  ["3-9001", "Ekuitas saldo awal", "equity", null, { systemKey: "equity.opening_balance", cashFlow: "none" }],

  // 4 PENDAPATAN
  ["4-1100", "Penjualan", "revenue", null, { header: true }],
  ["4-1101", "Penjualan Website", "revenue", "4-1100", { systemKey: "revenue.web" }],
  ["4-1102", "Penjualan Shopee", "revenue", "4-1100", { systemKey: "revenue.shopee" }],
  ["4-1103", "Penjualan TikTok", "revenue", "4-1100", { systemKey: "revenue.tiktok" }],
  ["4-1105", "Penjualan WhatsApp/Instagram/Offline", "revenue", "4-1100", { systemKey: "revenue.manual" }],
  ["4-1201", "Potongan penjualan (voucher & diskon)", "contra_revenue", null, { systemKey: "contra_revenue.sales_discount" }],
  ["4-1301", "Retur penjualan", "contra_revenue", null, { systemKey: "contra_revenue.sales_return" }],

  // 5 HARGA POKOK PENJUALAN
  ["5-1101", "HPP barang jadi", "cogs", null, { systemKey: "cogs.finished_goods" }],
  ["5-1201", "Selisih biaya produksi", "cogs", null, { systemKey: "cogs.production_variance" }],

  // 6 BEBAN USAHA
  ["6-1000", "Beban penjualan & pemasaran", "expense", null, { header: true }],
  ["6-1101", "Iklan", "expense", "6-1000"],
  ["6-1102", "Endorse/KOL", "expense", "6-1000"],
  ["6-1201", "Biaya platform marketplace", "expense", "6-1000", { systemKey: "expense.marketplace_fee" }],
  ["6-1202", "Subsidi ongkir penjual (marketplace)", "expense", "6-1000", { systemKey: "expense.marketplace_shipping_subsidy" }],
  ["6-1203", "Biaya payment gateway", "expense", "6-1000", { systemKey: "expense.payment_gateway" }],
  ["6-1301", "Beban ongkos kirim penjualan", "expense", "6-1000", { systemKey: "expense.sales_shipping" }],
  ["6-1302", "Subsidi ongkir website", "expense", "6-1000", { systemKey: "expense.web_shipping_subsidy" }],
  ["6-1401", "Packaging", "expense", "6-1000"],
  ["6-2000", "Beban umum & administrasi", "expense", null, { header: true }],
  ["6-2101", "Gaji", "expense", "6-2000"],
  ["6-2201", "Sewa", "expense", "6-2000"],
  ["6-2301", "Utilitas", "expense", "6-2000"],
  ["6-2401", "Beban penyusutan", "expense", "6-2000", { systemKey: "expense.depreciation" }],
  ["6-2501", "Beban langganan aplikasi", "expense", "6-2000", { systemKey: "expense.subscriptions" }],
  ["6-2901", "Beban lain-lain", "expense", "6-2000", { systemKey: "expense.other" }],
  ["6-3101", "Ongkir bahan", "expense", null],
  ["6-4000", "Beban persediaan", "expense", null, { header: true }],
  ["6-4101", "Selisih persediaan", "expense", "6-4000", { systemKey: "expense.inventory_variance" }],
  ["6-4102", "Kerusakan & kehilangan persediaan", "expense", "6-4000", { systemKey: "expense.inventory_loss" }],
  ["6-4103", "Barang cacat dilepas", "expense", "6-4000", { systemKey: "expense.defect_release" }],

  // 7 PENDAPATAN LAIN-LAIN
  ["7-1101", "Hasil lelang barang cacat", "other_income", null, { systemKey: "other_income.defect_auction" }],
  ["7-1102", "Bunga bank", "other_income", null],
  ["7-1103", "Selisih pembulatan/lain-lain", "other_income", null],

  // 8 BEBAN LAIN-LAIN
  ["8-1101", "Administrasi bank", "other_expense", null],
  ["8-1102", "Rugi pelepasan aset tetap", "other_expense", null, { cashFlow: "investing" }],

  // 9 PAJAK
  ["9-1101", "Beban PPh final", "tax", null, { systemKey: "tax.pph_final" }],
];

export const CHART_OF_ACCOUNTS: readonly AccountSeed[] = ROWS.map(([code, name, type, parentCode, options = {}], index) => {
  const isHeader = options.header ?? false;
  return {
    code,
    name,
    type,
    normalBalance: options.normalBalance ?? (DEBIT_NORMAL.includes(type) ? "debit" : "credit"),
    parentCode,
    isHeader,
    systemKey: options.systemKey ?? null,
    cashFlowGroup: options.cashFlow ?? (isHeader ? "none" : "operating"),
    sortOrder: (index + 1) * 10,
  };
});

/** system_key → code, for the keys a later session's posting rules name. */
/** Migration 0054 (owner + accountant, 27 Nov 2026): Piutang Midtrans and the marketplace
 * balances are receivables, not cash, so Arus kas counts a sale as cash only once the money reaches
 * Kas/Bank. 0049 (already deployed, never edited) seeded them as `cash`; 0054 moves each row still
 * at that value to the group CHART_OF_ACCOUNTS now holds. The migration tests read this. */
export const CASH_FLOW_GROUP_BEFORE_0054: Readonly<Record<string, CashFlowGroup>> = {
  "1-1301": "cash",
  "1-1302": "cash",
  "1-1303": "cash",
  "1-1305": "cash",
};

export function systemAccountCode(systemKey: string): string {
  const account = CHART_OF_ACCOUNTS.find((row) => row.systemKey === systemKey);
  if (!account) throw new Error(`unknown system account key "${systemKey}"`);
  return account.code;
}

/** The revenue account per sales channel (plan §3, 4-110x). The unused `reseller` channel maps to
 * 4-1105 so a stray order never blocks posting. */
const REVENUE_BY_CHANNEL: Record<ChannelId, string> = {
  web: "4-1101",
  shopee: "4-1102",
  tiktok: "4-1103",
  whatsapp: "4-1105",
  instagram: "4-1105",
  offline: "4-1105",
  reseller: "4-1105",
};

/** The initial expense-category mapping (D-25): one account per category. */
const EXPENSE_BY_CATEGORY: Record<DefaultExpenseCategoryCode, string> = {
  ads_meta: "6-1101",
  ads_tiktok: "6-1101",
  ads_shopee: "6-1101",
  endorsement: "6-1102",
  material_shipping: "6-3101",
  packaging: "6-1401",
  salary: "6-2101",
  rent: "6-2201",
  utilities: "6-2301",
  other: "6-2901",
};

export interface AccountMappingSeed {
  mappingKey: string;
  accountCode: string;
}

/** Initial account_mappings (plan §2.1, §3). Payment methods follow D-17/D-18 (one bank; "Kartu"
 * is a debit card). Item overrides (`expense.item.<uuid>`, e.g. "Biteship Grow" → 6-2501) are not
 * seeded: items are owner data with random ids, mapped in the mapping editor (Session 3). */
export const DEFAULT_ACCOUNT_MAPPINGS: readonly AccountMappingSeed[] = [
  { mappingKey: "cash.method.cash", accountCode: "1-1101" },
  { mappingKey: "cash.method.transfer", accountCode: "1-1201" },
  { mappingKey: "cash.method.card", accountCode: "1-1201" },
  { mappingKey: "cash.midtrans_payout", accountCode: "1-1201" },
  ...(Object.entries(REVENUE_BY_CHANNEL) as [ChannelId, string][]).map(([channel, accountCode]) => ({
    mappingKey: `revenue.channel.${channel}`,
    accountCode,
  })),
  ...(Object.entries(EXPENSE_BY_CATEGORY) as [DefaultExpenseCategoryCode, string][]).map(([category, accountCode]) => ({
    mappingKey: `expense.category.${category}`,
    accountCode,
  })),
  { mappingKey: "supplier_payable.kind.material", accountCode: "2-1101" },
  { mappingKey: "supplier_payable.kind.service", accountCode: "2-1102" },
  { mappingKey: "supplier_payable.kind.no_supplier", accountCode: "2-1103" },
];

export interface TaxSettingSeed {
  effectiveFrom: string;
  taxpayerType: TaxpayerType;
  taxpayerLabel: string;
  npwpRegisteredYear: number | null;
  rateBps: number;
  annualExemptionAmount: number;
  rateValidUntil: string | null;
  note: string | null;
}

/** The initial PPh final row (D-20). Effective from the trial month, the first month the ledger
 * posts; the rate ends 2026-12-31 under the original PP 55/2022 until the accountant enters the
 * date from the PP 55 revision. */
export const INITIAL_TAX_SETTING: TaxSettingSeed = {
  effectiveFrom: "2026-12-01",
  taxpayerType: "individual",
  taxpayerLabel: "Istri pemilik, orang pribadi",
  npwpRegisteredYear: 2020,
  rateBps: 50,
  annualExemptionAmount: 500_000_000,
  rateValidUntil: "2026-12-31",
  note: "Tarif PPh final 0,5% (PP 55/2022). Perbarui tanggal akhir setelah revisi PP 55 dipastikan.",
};

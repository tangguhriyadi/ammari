import type { AccountNormalBalance, AccountType, CashFlowGroup, JournalEntryKind, TaxpayerType } from "@ammari/db/schema";

// Indonesian labels for the ledger pages (docs/plans/accounting.md §6). Keys are the posting
// sources and issue codes the engine writes (packages/accounting); an unknown value falls back to
// a neutral label instead of failing, since later sessions add sources before this file knows them.

export const JOURNAL_SOURCE_TYPE_LABELS = {
  business_expense: "Biaya",
  supplier_payment: "Pembayaran supplier",
} as const;
export type JournalSourceType = keyof typeof JOURNAL_SOURCE_TYPE_LABELS;

export function sourceTypeLabel(sourceType: string | null): string {
  if (sourceType === null) return "Jurnal manual";
  return (JOURNAL_SOURCE_TYPE_LABELS as Record<string, string>)[sourceType] ?? "Sumber lain";
}

const SOURCE_EVENT_LABELS: Record<string, string> = {
  paid: "Dicatat",
  void: "Dibatalkan",
};

export function sourceEventLabel(sourceEvent: string | null): string | null {
  if (sourceEvent === null) return null;
  return SOURCE_EVENT_LABELS[sourceEvent] ?? null;
}

export const JOURNAL_KIND_LABELS: Record<JournalEntryKind, string> = {
  system: "Otomatis",
  manual: "Manual",
  opening: "Saldo awal",
  reversal: "Pembalik",
  closing: "Penutup",
  depreciation: "Penyusutan",
};

const METHOD_LABELS: Record<string, string> = {
  cash: "Tunai",
  transfer: "Transfer",
  card: "Kartu",
  platform_balance: "Saldo marketplace",
};

/** What a posting issue means and what to do about it. */
export function postingIssueMessage(issueCode: string, details: Record<string, unknown>): string {
  const text = (key: string) => (typeof details[key] === "string" ? (details[key] as string) : "");
  switch (issueCode) {
    case "unmapped_expense_category":
      return `Kategori biaya "${text("categoryName") || text("category")}" belum dipetakan ke akun. Petakan dulu agar biaya ini bisa dibukukan.`;
    case "unmapped_payment_method":
      return `Cara bayar "${METHOD_LABELS[text("method")] ?? text("method")}" belum dipetakan ke akun kas atau bank.`;
    case "unmapped_supplier_payable":
      return "Akun utang supplier belum dipetakan.";
    case "expense_mapped_to_inventory":
      return `Kategori biaya dipetakan ke akun persediaan ${text("accountCode")}. Bahan masuk persediaan hanya lewat penerimaan barang; petakan kategori ini ke akun beban.`;
    case "purchase_guard_violation":
      return "Pembayaran supplier tidak boleh dibukukan ke akun beban. Periksa pemetaan akun utang supplier.";
    case "manual_payment_missing":
      return `Pesanan manual ${text("orderNo")} belum dicatat cara bayar dan rekening tujuannya. Isi lewat tombol Isi cara bayar di halaman pesanan.`;
    case "account_not_postable":
      return "Akun tujuan sudah nonaktif, berupa akun induk, atau tidak ada.";
    case "missing_system_account":
      return "Akun sistem tidak ditemukan di daftar akun.";
    case "invalid_journal":
      return "Jurnal tidak seimbang atau tidak valid, sehingga tidak dibukukan.";
    case "posting_failed":
      return `Gagal dibukukan: ${text("message") || "kesalahan tidak dikenal"}. Coba posting lagi.`;
    default:
      return "Sumber ini belum bisa dibukukan.";
  }
}

// ---------- Data Master Akun, Pemetaan akun, Pengaturan pajak (Session 3) ----------

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: "Aset",
  liability: "Kewajiban",
  equity: "Ekuitas",
  revenue: "Pendapatan",
  contra_revenue: "Pengurang pendapatan",
  cogs: "HPP",
  expense: "Beban",
  other_income: "Pendapatan lain-lain",
  other_expense: "Beban lain-lain",
  tax: "Pajak",
};

export const NORMAL_BALANCE_LABELS: Record<AccountNormalBalance, string> = {
  debit: "Debit",
  credit: "Kredit",
};

export const CASH_FLOW_GROUP_LABELS: Record<CashFlowGroup, string> = {
  operating: "Operasi",
  investing: "Investasi",
  financing: "Pendanaan",
  cash: "Kas, bank & saldo",
  none: "Tidak dihitung",
};

export const TAXPAYER_TYPE_LABELS: Record<TaxpayerType, string> = {
  individual: "Orang pribadi",
  company: "Badan (PT)",
};

export const PAYMENT_METHOD_MAPPING_LABELS: Record<string, string> = {
  "cash.method.cash": "Tunai",
  "cash.method.transfer": "Transfer",
  "cash.method.card": "Kartu (debit)",
  "cash.midtrans_payout": "Pencairan Midtrans",
};

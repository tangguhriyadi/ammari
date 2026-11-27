import type { AccountNormalBalance, AccountType, CashFlowGroup, JournalEntryKind, TaxpayerType } from "@ammari/db/schema";

// Indonesian labels for the ledger pages (docs/plans/accounting.md §6). Keys are the posting
// sources and issue codes the engine writes (packages/accounting); an unknown value falls back to
// a neutral label instead of failing, since later sessions add sources before this file knows them.

export const JOURNAL_SOURCE_TYPE_LABELS = {
  business_expense: "Biaya",
  supplier_payment: "Pembayaran supplier",
  goods_receipt_item: "Penerimaan barang",
  purchase: "Pembelian",
  defect_movement: "Barang cacat",
  fabric_stock_movement: "Penyesuaian stok kain",
  accessory_movement: "Penyesuaian stok aksesoris",
  production_batch: "Batch produksi",
  stock_movement: "Stok barang jadi",
  order: "Pesanan",
  payment: "Pembayaran Midtrans",
  shipment: "Pengiriman kurir",
  order_channel_fee: "Biaya Midtrans",
  order_settlement: "Pencairan Midtrans",
} as const;
export type JournalSourceType = keyof typeof JOURNAL_SOURCE_TYPE_LABELS;

export function sourceTypeLabel(sourceType: string | null): string {
  if (sourceType === null) return "Jurnal manual";
  return (JOURNAL_SOURCE_TYPE_LABELS as Record<string, string>)[sourceType] ?? "Sumber lain";
}

const SOURCE_EVENT_LABELS: Record<string, string> = {
  paid: "Dicatat",
  void: "Dibatalkan",
  received: "Diterima",
  reversed: "Penerimaan dibatalkan",
  closed_overpaid: "Ditutup, lebih bayar",
  return_out: "Diretur ke supplier",
  adjustment: "Penyesuaian",
  legacy_purchase: "Pembelian lama",
  sale: "Barang keluar",
  return: "Barang kembali",
  recognised: "Penjualan diakui",
  collected: "Uang masuk",
  returned: "Retur",
  cancelled_paid: "Dibatalkan setelah dibayar",
  channel_fees: "Biaya marketplace",
  refunded: "Dana dikembalikan",
  gateway_refunded: "Dana dikembalikan lewat Midtrans",
  chargeback: "Chargeback",
  charged: "Ongkir kurir",
  cancelled: "Pengiriman dibatalkan",
  mdr: "Biaya Midtrans",
  settled: "Pencairan",
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
      return "Pembelian dan pembayaran supplier tidak boleh dibukukan ke akun beban. Periksa pemetaan akun utang supplier.";
    case "receipt_value_missing":
      return `Nilai penerimaan ${text("receiptNo")} tidak ditemukan di catatan stok, jadi penerimaan ini dan kejadian sesudahnya di dokumen yang sama belum bisa dibukukan.`;
    case "receipt_value_invalid":
      return `Nilai penerimaan ${text("receiptNo")} di catatan stok tidak wajar (negatif), jadi dokumen ini belum bisa dibukukan.`;
    case "receipt_reversal_unmatched":
      return `Pembatalan penerimaan ${text("receiptNo")} tidak menemukan penerimaan aslinya, jadi dokumen ini belum bisa dibukukan.`;
    case "purchase_chain_inconsistent":
      return "Urutan kejadian dokumen pembelian ini tidak konsisten, jadi belum bisa dibukukan. Hubungi pengelola aplikasi.";
    case "legacy_raw_purchase":
      return `Pembelian bahan "${text("itemName")}" dicatat dengan cara lama (tanpa dokumen pembelian). Bahan masuk buku hanya lewat penerimaan barang; buat jurnal manual bila perlu.`;
    case "adjustment_reason_missing":
      return "Penyesuaian stok tanpa alasan tidak bisa dipilihkan akun bebannya.";
    case "manual_payment_missing":
      return `Pesanan manual ${text("orderNo")} belum dicatat cara bayar dan rekening tujuannya. Isi lewat tombol Isi cara bayar di halaman pesanan.`;
    case "marketplace_ship_date_missing":
      return `Pesanan ${text("orderNo")} belum punya tanggal kirim asli dari file ekspor marketplace, jadi penjualannya belum dibukukan (tanggal unggah tidak dipakai). Biaya marketplace dan retur pesanan ini menunggu sampai tanggalnya ada.`;
    case "payment_chargeback":
      return `Pembayaran ${text("providerOrderId")} pesanan ${text("orderNo")} terkena chargeback. Jumlahnya tidak tercatat, jadi buat jurnal manual sesuai laporan Midtrans.`;
    case "unmapped_sales_channel":
      return `Kanal penjualan "${text("channelId")}" belum dipetakan ke akun penjualan.`;
    case "unmapped_fixed_asset_disposal":
      return "Akun laba/rugi pelepasan aset tetap belum dipetakan (kunci fixed_asset.disposal_result), jadi pelepasan aset ini belum dibukukan.";
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

import { isCalendarDate, journalLinesProblems, monthEndOf, TRIAL_BOOKS_END, TRIAL_BOOKS_START, type JournalLineDraft } from "@ammari/accounting";
import { FieldError } from "@/lib/errors";
import { parseRupiah } from "@/lib/products/money";

// Manual journals (docs/plans/accounting.md §5, Session 4): only for what the system does not
// record (modal, prive, top-up Biteship, penarikan saldo, accruals...). Pure validation shared by the
// form's server action and the write (manual-journals.ts), so every refusal is a field message
// before anything is stored; the 0049 triggers refuse the same things again as the backstop.

export const MAX_MANUAL_JOURNAL_LINES = 40;
export const MAX_JOURNAL_DESCRIPTION_LENGTH = 500;
export const MAX_LINE_MEMO_LENGTH = 500;
/** Rp1 triliun per line: far above any real entry, and keeps every total a safe integer. */
export const MAX_LINE_AMOUNT = 1_000_000_000_000;
export const MAX_REVERSAL_REASON_LENGTH = 300;

export const MANUAL_JOURNAL_MESSAGES = {
  invalidDate: "Tanggal jurnal tidak valid.",
  beforeBooks: "Tanggal jurnal paling awal 1 Desember 2026 (bulan uji coba).",
  futureMonth: "Tanggal jurnal tidak boleh setelah akhir bulan ini.",
  closedMonth: "Bulan ini sudah ditutup. Pilih tanggal di bulan yang masih terbuka, atau minta pemilik membuka kembali bulan itu.",
  descriptionRequired: "Keterangan wajib diisi.",
  descriptionTooLong: `Keterangan maksimal ${MAX_JOURNAL_DESCRIPTION_LENGTH} karakter.`,
  tooFewLines: "Jurnal butuh paling sedikit dua baris.",
  tooManyLines: `Jurnal paling banyak ${MAX_MANUAL_JOURNAL_LINES} baris.`,
  accountRequired: "Pilih akun di setiap baris.",
  accountNotPostable: "Akun ini akun induk, nonaktif, atau tidak ada. Pilih akun lain.",
  amount: "Isi debit ATAU kredit dengan bilangan bulat lebih dari 0 (tanpa koma).",
  amountTooLarge: "Jumlah per baris terlalu besar.",
  memoTooLong: `Catatan baris maksimal ${MAX_LINE_MEMO_LENGTH} karakter.`,
  unbalanced: "Total debit dan total kredit harus sama.",
  reasonRequired: "Alasan pembalikan wajib diisi.",
  reasonTooLong: `Alasan maksimal ${MAX_REVERSAL_REASON_LENGTH} karakter.`,
  notFound: "Jurnal tidak ditemukan.",
  alreadyReversed: "Jurnal ini sudah dibalik.",
  notManual: "Hanya jurnal manual dan saldo awal yang bisa dibalik di sini. Jurnal otomatis dibalik oleh posting.",
} as const;

export interface ManualJournalLineInput {
  accountCode: string;
  /** As typed: "1.500.000", "" for none. */
  debit: string;
  credit: string;
  memo?: string | null;
}

export interface ManualJournalFormInput {
  entryDate: string;
  description: string;
  lines: ManualJournalLineInput[];
}

export interface PostableAccountInfo {
  isActive: boolean;
  isHeader: boolean;
}

export interface ValidatedManualJournal {
  entryDate: string;
  description: string;
  lines: JournalLineDraft[];
}

/** The amount of one side: 0 when blank, null when malformed. */
export function sideAmount(raw: string): number | null {
  if (raw.trim() === "") return 0;
  return parseRupiah(raw);
}

/** The latest date a manual journal may carry: the current month's last day (an accrual is dated
 * there), and never earlier than the end of the December 2026 trial month, so the trial month can be
 * practised before it starts (it is never part of the official books, D-22). */
export function latestManualJournalDate(today: string): string {
  const monthEnd = monthEndOf(today);
  return monthEnd > TRIAL_BOOKS_END ? monthEnd : TRIAL_BOOKS_END;
}

/** The form's default date: today, or the trial month's first day before it starts. */
export function defaultManualJournalDate(today: string): string {
  return today < TRIAL_BOOKS_START ? TRIAL_BOOKS_START : today;
}

/** Fully blank rows (no account, no amount, no memo) are a form's spare rows. */
export function isBlankLineRow(line: ManualJournalLineInput): boolean {
  return line.accountCode.trim() === "" && line.debit.trim() === "" && line.credit.trim() === "" && (line.memo ?? "").trim() === "";
}

/** Each non-blank row as a journal line: a postable account, exactly one positive side in whole
 * rupiah, an optional memo. Field keys `<prefix>.<i>.<field>`, `i` counting the rows as given (so
 * the form can point at the row on screen). Counts and balance are the caller's. */
export function validateJournalLineRows(rows: readonly ManualJournalLineInput[], accounts: ReadonlyMap<string, PostableAccountInfo>, prefix = "lines"): JournalLineDraft[] {
  const lines: JournalLineDraft[] = [];
  rows.forEach((row, index) => {
    if (isBlankLineRow(row)) return;
    const accountCode = row.accountCode.trim();
    if (accountCode === "") throw new FieldError(`${prefix}.${index}.accountCode`, MANUAL_JOURNAL_MESSAGES.accountRequired);
    const account = accounts.get(accountCode);
    if (!account || !account.isActive || account.isHeader) throw new FieldError(`${prefix}.${index}.accountCode`, MANUAL_JOURNAL_MESSAGES.accountNotPostable);
    const debit = sideAmount(row.debit);
    const credit = sideAmount(row.credit);
    if (debit === null || credit === null || (debit > 0) === (credit > 0)) throw new FieldError(`${prefix}.${index}.debit`, MANUAL_JOURNAL_MESSAGES.amount);
    if (debit > MAX_LINE_AMOUNT || credit > MAX_LINE_AMOUNT) throw new FieldError(`${prefix}.${index}.debit`, MANUAL_JOURNAL_MESSAGES.amountTooLarge);
    const memo = (row.memo ?? "").trim();
    if (memo.length > MAX_LINE_MEMO_LENGTH) throw new FieldError(`${prefix}.${index}.memo`, MANUAL_JOURNAL_MESSAGES.memoTooLong);
    lines.push({ accountCode, debit, credit, memo: memo === "" ? null : memo });
  });
  return lines;
}

/** Field keys: `entryDate`, `description`, `lines` (the whole set), `lines.<i>.<field>`. */
export function validateManualJournal(
  input: ManualJournalFormInput,
  options: { today: string; accounts: ReadonlyMap<string, PostableAccountInfo>; closedMonths?: ReadonlySet<string> },
): ValidatedManualJournal {
  const entryDate = input.entryDate.trim();
  if (!isCalendarDate(entryDate)) throw new FieldError("entryDate", MANUAL_JOURNAL_MESSAGES.invalidDate);
  if (entryDate < TRIAL_BOOKS_START) throw new FieldError("entryDate", MANUAL_JOURNAL_MESSAGES.beforeBooks);
  if (entryDate > latestManualJournalDate(options.today)) throw new FieldError("entryDate", MANUAL_JOURNAL_MESSAGES.futureMonth);
  if (options.closedMonths?.has(`${entryDate.slice(0, 7)}-01`)) throw new FieldError("entryDate", MANUAL_JOURNAL_MESSAGES.closedMonth);

  const description = input.description.trim();
  if (description === "") throw new FieldError("description", MANUAL_JOURNAL_MESSAGES.descriptionRequired);
  if (description.length > MAX_JOURNAL_DESCRIPTION_LENGTH) throw new FieldError("description", MANUAL_JOURNAL_MESSAGES.descriptionTooLong);

  const lines = validateJournalLineRows(input.lines, options.accounts);
  if (lines.length > MAX_MANUAL_JOURNAL_LINES) throw new FieldError("lines", MANUAL_JOURNAL_MESSAGES.tooManyLines);
  if (lines.length < 2) throw new FieldError("lines", MANUAL_JOURNAL_MESSAGES.tooFewLines);

  // The engine's own check (same rules as the database), so nothing this accepts is refused at commit.
  const problems = journalLinesProblems(lines);
  if (problems.some((problem) => problem.code === "unbalanced")) throw new FieldError("lines", MANUAL_JOURNAL_MESSAGES.unbalanced);
  if (problems.length > 0) throw new FieldError("lines", MANUAL_JOURNAL_MESSAGES.amount);

  return { entryDate, description, lines };
}

export function normalizeReversalReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", MANUAL_JOURNAL_MESSAGES.reasonRequired);
  if (trimmed.length > MAX_REVERSAL_REASON_LENGTH) throw new FieldError("reason", MANUAL_JOURNAL_MESSAGES.reasonTooLong);
  return trimmed;
}

// ---------- Templates (plan §5.5, §8 Session 4) ----------

export interface ManualJournalTemplateLine {
  /** accounts.system_key, so a renamed or renumbered account still resolves. */
  systemKey: string;
  side: "debit" | "credit";
}

export interface ManualJournalTemplate {
  key: string;
  label: string;
  description: string;
  hint: string;
  lines: readonly ManualJournalTemplateLine[];
}

/** Prefills for the recurring manual entries the plan names. The amount is always typed. */
export const MANUAL_JOURNAL_TEMPLATES: readonly ManualJournalTemplate[] = [
  {
    key: "biteship_topup",
    label: "Top-up Saldo Biteship",
    description: "Top-up Saldo Biteship",
    hint: "Satu jurnal per top-up, dari mutasi bank (Keputusan 10).",
    lines: [
      { systemKey: "prepaid.biteship", side: "debit" },
      { systemKey: "bank.main", side: "credit" },
    ],
  },
  {
    key: "shopee_withdrawal",
    label: "Penarikan Saldo Penjual Shopee",
    description: "Penarikan Saldo Penjual Shopee ke bank",
    hint: "Dari mutasi bank pada hari dana masuk (Keputusan 11).",
    lines: [
      { systemKey: "bank.main", side: "debit" },
      { systemKey: "seller_balance.shopee", side: "credit" },
    ],
  },
  {
    key: "tiktok_withdrawal",
    label: "Penarikan Saldo Penjual TikTok",
    description: "Penarikan Saldo Penjual TikTok ke bank",
    hint: "Dari mutasi bank pada hari dana masuk (Keputusan 11).",
    lines: [
      { systemKey: "bank.main", side: "debit" },
      { systemKey: "seller_balance.tiktok", side: "credit" },
    ],
  },
  {
    key: "refund_via_midtrans",
    label: "Koreksi refund lewat Midtrans",
    description: "Koreksi: refund dikembalikan lewat dashboard Midtrans, bukan dari Bank utama",
    hint: "Refund yang dicatat staf dianggap dari Bank utama (Keputusan 9). Pakai ini bila ternyata lewat Midtrans.",
    lines: [
      { systemKey: "bank.main", side: "debit" },
      { systemKey: "receivable.midtrans", side: "credit" },
    ],
  },
  {
    key: "opening_equity_to_capital",
    label: "Tutup ekuitas saldo awal ke modal",
    description: "Pemindahan Ekuitas saldo awal ke Modal pemilik setelah saldo awal disetujui",
    hint: "Setelah saldo awal diperiksa (Keputusan 22). Isi sebesar saldo akun Ekuitas saldo awal.",
    lines: [
      { systemKey: "equity.opening_balance", side: "debit" },
      { systemKey: "equity.owner_capital", side: "credit" },
    ],
  },
];

export function findTemplate(key: string | undefined | null): ManualJournalTemplate | null {
  if (!key) return null;
  return MANUAL_JOURNAL_TEMPLATES.find((template) => template.key === key) ?? null;
}

import type { AccountType, CashFlowGroup } from "@ammari/db/schema";

// The three financial statements (docs/plans/accounting.md §6, Session 10) as pure layouts built
// from account balances, so the page, the PDF and the Excel file all show the same rows and the
// rules are unit-tested without a database:
//   - Neraca (laporan posisi keuangan, SAK EMKM): aset / kewajiban / ekuitas, with the P&L accounts'
//     not-yet-closed result as "Laba (rugi) berjalan" so the statement balances.
//   - Laba rugi: penjualan − potongan & retur = penjualan bersih; − HPP (cogs accounts only:
//     5-1101 and 5-1201) = laba kotor; − beban usaha (every expense account, so 6-4000 Beban
//     persediaan sits here and never in HPP, D-7/D-16); ± lain-lain; − pajak = laba bersih.
//   - Arus kas (direct method): every line on a "cash" account (cash_flow_group = 'cash': kas, bank,
//     Piutang Midtrans, Saldo Penjual) classified by its journal's counter-accounts' group.
// Sections follow the account TYPE and the header tree the accountant maintains (Data Master Akun),
// never hard-coded account codes, so a new sub-account lands in the right place by itself.

export interface StatementAccount {
  code: string;
  name: string;
  type: AccountType;
  parentCode: string | null;
  isHeader: boolean;
  isActive: boolean;
  cashFlowGroup: CashFlowGroup;
}

export type StatementRowStyle = "section" | "group" | "account" | "subtotal" | "total";

export interface StatementRow {
  key: string;
  label: string;
  style: StatementRowStyle;
  depth: number;
  /** One per column; null = no figure (section and group headings). */
  amounts: (number | null)[];
  /** For drill-down to the ledger. */
  accountCode?: string;
}

export interface StatementColumn {
  key: string;
  label: string;
}

export interface StatementCheck {
  label: string;
  ok: boolean;
}

export interface Statement {
  columns: StatementColumn[];
  rows: StatementRow[];
  checks: StatementCheck[];
}

/** Signed debit − credit per column, by account code. */
export type BalancesByAccount = ReadonlyMap<string, readonly number[]>;

export const PROFIT_AND_LOSS_TYPES = ["revenue", "contra_revenue", "cogs", "expense", "other_income", "other_expense", "tax"] as const satisfies readonly AccountType[];
const PNL = new Set<AccountType>(PROFIT_AND_LOSS_TYPES);
export const isProfitAndLossType = (type: AccountType) => PNL.has(type);

/** The account types whose balance raises profit (credit side). */
const INCOME_TYPES = new Set<AccountType>(["revenue", "other_income"]);

const zeros = (n: number) => Array.from({ length: n }, () => 0);
const add = (a: readonly number[], b: readonly number[]) => a.map((value, index) => value + (b[index] ?? 0));
const scale = (a: readonly number[], factor: number) => a.map((value) => value * factor || 0);
const anyNonZero = (a: readonly number[]) => a.some((value) => value !== 0);

interface TreeResult {
  rows: StatementRow[];
  total: number[];
}

/**
 * The accounts of `types` as a header tree: a header with anything to show gets a heading row, its
 * children, and a "Jumlah ..." row when it shows more than one child; an account shows when any
 * column is non-zero. `sign` turns debit − credit into the section's own side (+1 debit, −1 credit).
 * An account whose parent is not in the set (no header) sits directly in the section.
 */
function accountTree(accounts: readonly StatementAccount[], types: ReadonlySet<AccountType>, balances: BalancesByAccount, width: number, sign: number, depth: number, filter?: (account: StatementAccount) => boolean): TreeResult {
  const inSet = accounts.filter((account) => types.has(account.type) && (account.isHeader || !filter || filter(account)));
  const codes = new Set(inSet.map((account) => account.code));
  const children = new Map<string | null, StatementAccount[]>();
  for (const account of inSet) {
    const parent = account.parentCode && codes.has(account.parentCode) ? account.parentCode : null;
    children.set(parent, [...(children.get(parent) ?? []), account]);
  }

  const walk = (account: StatementAccount, level: number): TreeResult => {
    if (!account.isHeader) {
      const amounts = scale(balances.get(account.code) ?? zeros(width), sign);
      if (!anyNonZero(amounts)) return { rows: [], total: zeros(width) };
      return {
        rows: [{ key: account.code, label: account.isActive ? account.name : `${account.name} (nonaktif)`, style: "account", depth: level, amounts, accountCode: account.code }],
        total: amounts,
      };
    }
    const parts = (children.get(account.code) ?? []).map((child) => walk(child, level + 1)).filter((part) => part.rows.length > 0);
    if (parts.length === 0) return { rows: [], total: zeros(width) };
    const total = parts.reduce((sum, part) => add(sum, part.total), zeros(width));
    const rows: StatementRow[] = [{ key: `${account.code}:group`, label: account.name, style: "group", depth: level, amounts: Array.from({ length: width }, () => null) }, ...parts.flatMap((part) => part.rows)];
    if (parts.length > 1) rows.push({ key: `${account.code}:subtotal`, label: `Jumlah ${account.name.toLowerCase()}`, style: "subtotal", depth: level, amounts: total });
    return { rows, total };
  };

  const parts = (children.get(null) ?? []).map((account) => walk(account, depth)).filter((part) => part.rows.length > 0);
  return { rows: parts.flatMap((part) => part.rows), total: parts.reduce((sum, part) => add(sum, part.total), zeros(width)) };
}

const section = (key: string, label: string, width: number): StatementRow => ({ key, label, style: "section", depth: 0, amounts: Array.from({ length: width }, () => null) });
const sumRow = (key: string, label: string, amounts: number[], style: "subtotal" | "total" = "subtotal", depth = 0): StatementRow => ({ key, label, style, depth, amounts });

// ---------- Neraca ----------

/** A liability coded 2-2xxx is long-term (the chart's convention: 2-1 = jangka pendek, 2-2 = jangka panjang). */
export const isLongTermLiability = (account: Pick<StatementAccount, "code">) => account.code.startsWith("2-2");

export interface BalanceSheetFigures {
  totalAssets: number[];
  totalLiabilities: number[];
  totalEquity: number[];
  /** The P&L accounts' balance (credit − debit): the result not yet closed into equity. */
  currentEarnings: number[];
}

/** `balances`: closing balance per account per column (Σ debit − credit from the segment's first day). */
export function buildBalanceSheet(accounts: readonly StatementAccount[], balances: BalancesByAccount, columns: StatementColumn[]): Statement & { figures: BalanceSheetFigures } {
  const width = columns.length;
  const rows: StatementRow[] = [];

  rows.push(section("assets", "ASET", width));
  const assets = accountTree(accounts, new Set(["asset"]), balances, width, 1, 1);
  rows.push(...assets.rows, sumRow("assets:total", "Jumlah aset", assets.total, "total"));

  rows.push(section("liabilities", "KEWAJIBAN", width));
  const short = accountTree(accounts, new Set(["liability"]), balances, width, -1, 2, (account) => !isLongTermLiability(account));
  const long = accountTree(accounts, new Set(["liability"]), balances, width, -1, 2, isLongTermLiability);
  if (short.rows.length > 0) rows.push({ ...section("liabilities:short", "Kewajiban jangka pendek", width), style: "group", depth: 1 }, ...short.rows, sumRow("liabilities:short:total", "Jumlah kewajiban jangka pendek", short.total, "subtotal", 1));
  if (long.rows.length > 0) rows.push({ ...section("liabilities:long", "Kewajiban jangka panjang", width), style: "group", depth: 1 }, ...long.rows, sumRow("liabilities:long:total", "Jumlah kewajiban jangka panjang", long.total, "subtotal", 1));
  const totalLiabilities = add(short.total, long.total);
  rows.push(sumRow("liabilities:total", "Jumlah kewajiban", totalLiabilities, "total"));

  rows.push(section("equity", "EKUITAS", width));
  const equity = accountTree(accounts, new Set(["equity"]), balances, width, -1, 1);
  rows.push(...equity.rows);
  let currentEarnings = zeros(width);
  for (const account of accounts) {
    if (isProfitAndLossType(account.type) && !account.isHeader) currentEarnings = add(currentEarnings, scale(balances.get(account.code) ?? zeros(width), -1));
  }
  if (anyNonZero(currentEarnings)) rows.push({ key: "equity:current_earnings", label: "Laba (rugi) berjalan, belum ditutup", style: "account", depth: 1, amounts: currentEarnings });
  const totalEquity = add(equity.total, currentEarnings);
  rows.push(sumRow("equity:total", "Jumlah ekuitas", totalEquity, "total"));
  const liabilitiesAndEquity = add(totalLiabilities, totalEquity);
  rows.push(sumRow("liabilities_equity:total", "Jumlah kewajiban dan ekuitas", liabilitiesAndEquity, "total"));

  const checks = columns.map((column, index) => ({ label: `${column.label}: jumlah aset sama dengan jumlah kewajiban dan ekuitas`, ok: assets.total[index] === liabilitiesAndEquity[index] }));
  return { columns, rows, checks, figures: { totalAssets: assets.total, totalLiabilities, totalEquity, currentEarnings } };
}

// ---------- Laba rugi ----------

export interface IncomeStatementFigures {
  grossSales: number[];
  netSales: number[];
  cogs: number[];
  grossProfit: number[];
  operatingExpenses: number[];
  operatingProfit: number[];
  profitBeforeTax: number[];
  tax: number[];
  netIncome: number[];
}

/** `movements`: Σ debit − credit per account per column within the period (no opening, no closing). */
export function buildIncomeStatement(accounts: readonly StatementAccount[], movements: BalancesByAccount, columns: StatementColumn[]): Statement & { figures: IncomeStatementFigures } {
  const width = columns.length;
  const rows: StatementRow[] = [];
  const block = (key: string, label: string, type: AccountType, subtotalLabel: string): number[] => {
    const tree = accountTree(accounts, new Set([type]), movements, width, INCOME_TYPES.has(type) ? -1 : 1, 1);
    rows.push(section(key, label, width), ...tree.rows, sumRow(`${key}:total`, subtotalLabel, tree.total, "subtotal", 1));
    return tree.total;
  };
  const grossSales = block("revenue", "Penjualan", "revenue", "Jumlah penjualan");
  const deductions = block("contra_revenue", "Dikurangi: potongan dan retur penjualan", "contra_revenue", "Jumlah potongan dan retur");
  const netSales = add(grossSales, scale(deductions, -1));
  rows.push(sumRow("net_sales", "Penjualan bersih", netSales, "total"));
  const cogs = block("cogs", "Harga pokok penjualan", "cogs", "Jumlah harga pokok penjualan");
  const grossProfit = add(netSales, scale(cogs, -1));
  rows.push(sumRow("gross_profit", "Laba kotor", grossProfit, "total"));
  const operatingExpenses = block("expense", "Beban usaha", "expense", "Jumlah beban usaha");
  const operatingProfit = add(grossProfit, scale(operatingExpenses, -1));
  rows.push(sumRow("operating_profit", "Laba usaha", operatingProfit, "total"));
  const otherIncome = block("other_income", "Pendapatan lain-lain", "other_income", "Jumlah pendapatan lain-lain");
  const otherExpense = block("other_expense", "Beban lain-lain", "other_expense", "Jumlah beban lain-lain");
  const profitBeforeTax = add(add(operatingProfit, otherIncome), scale(otherExpense, -1));
  rows.push(sumRow("profit_before_tax", "Laba sebelum pajak", profitBeforeTax, "total"));
  const tax = block("tax", "Pajak penghasilan", "tax", "Jumlah pajak penghasilan");
  const netIncome = add(profitBeforeTax, scale(tax, -1));
  rows.push(sumRow("net_income", "Laba bersih", netIncome, "total"));

  // The layout must lose nothing: laba bersih equals Σ (credit − debit) over every P&L account.
  let direct = zeros(width);
  for (const account of accounts) if (isProfitAndLossType(account.type) && !account.isHeader) direct = add(direct, scale(movements.get(account.code) ?? zeros(width), -1));
  const checks = [{ label: "Laba bersih sama dengan selisih kredit dan debit semua akun laba rugi", ok: direct.every((value, index) => value === netIncome[index]) }];
  return { columns, rows, checks, figures: { grossSales, netSales, cogs, grossProfit, operatingExpenses, operatingProfit, profitBeforeTax, tax, netIncome } };
}

// ---------- Arus kas ----------

export interface CashFlowLine {
  entryId: string;
  accountCode: string;
  /** debit − credit. */
  net: number;
}

export const CASH_FLOW_ACTIVITY_GROUPS = ["operating", "investing", "financing", "none"] as const;
export type CashFlowActivity = (typeof CASH_FLOW_ACTIVITY_GROUPS)[number];

export interface CashFlowAllocation {
  /** Cash effect (+ in, − out) per activity, per counter-account. */
  byActivity: Record<CashFlowActivity, Map<string, number>>;
  netChange: number;
}

/** Types whose lines are a real source or use of cash on their own: never netted away. */
const NEVER_NETTED = new Set<AccountType>(["revenue", "contra_revenue", "other_income"]);

/**
 * Direct method (plan §6): per journal touching a cash account, the cash moved (Σ of its cash lines)
 * is explained by its other lines, each classified by its account's cash_flow_group. A journal whose
 * cash lines net to zero (Kas → Bank, Saldo Penjual → Bank) moves no cash; a journal with no cash
 * line (a purchase on credit) is not a cash flow at all. Inside one journal, two non-cash lines of
 * the SAME group that exactly offset each other (S3's HPP pair Dr 5-1101 / Cr 1-1505 riding along
 * with the sale) are dropped from the per-account detail: the group total is unchanged, the detail
 * just does not show money that never moved. Sales, discounts and returns are never netted away.
 */
export function allocateCashFlow(lines: readonly CashFlowLine[], accounts: ReadonlyMap<string, Pick<StatementAccount, "type" | "cashFlowGroup">>): CashFlowAllocation {
  const byEntry = new Map<string, CashFlowLine[]>();
  for (const line of lines) byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);
  const byActivity: Record<CashFlowActivity, Map<string, number>> = { operating: new Map(), investing: new Map(), financing: new Map(), none: new Map() };
  let netChange = 0;
  const groupOf = (code: string): CashFlowActivity => {
    const group = accounts.get(code)?.cashFlowGroup ?? "none";
    return group === "cash" ? "none" : group;
  };

  for (const entryLines of byEntry.values()) {
    const isCash = (code: string) => accounts.get(code)?.cashFlowGroup === "cash";
    const cash = entryLines.filter((line) => isCash(line.accountCode)).reduce((sum, line) => sum + line.net, 0);
    if (cash === 0) continue;
    netChange += cash;
    // Net per counter-account inside the entry, as a cash effect (the opposite of its debit − credit).
    const effects = new Map<string, number>();
    for (const line of entryLines) if (!isCash(line.accountCode)) effects.set(line.accountCode, (effects.get(line.accountCode) ?? 0) - line.net);
    const nettable = [...effects.entries()].filter(([code, value]) => value !== 0 && !NEVER_NETTED.has(accounts.get(code)?.type ?? "asset"));
    for (const [code, value] of nettable) {
      if (effects.get(code) !== value) continue;
      const partner = nettable.find(([other, otherValue]) => other !== code && effects.get(other) === otherValue && otherValue === -value && groupOf(other) === groupOf(code));
      if (partner) {
        effects.set(code, 0);
        effects.set(partner[0], 0);
      }
    }
    for (const [code, value] of effects) {
      if (value === 0) continue;
      const target = byActivity[groupOf(code)];
      target.set(code, (target.get(code) ?? 0) + value);
    }
  }
  return { byActivity, netChange };
}

const ACTIVITY_LABELS: Record<CashFlowActivity, { title: string; total: string }> = {
  operating: { title: "Arus kas dari aktivitas operasi", total: "Kas bersih dari aktivitas operasi" },
  investing: { title: "Arus kas dari aktivitas investasi", total: "Kas bersih dari aktivitas investasi" },
  financing: { title: "Arus kas dari aktivitas pendanaan", total: "Kas bersih dari aktivitas pendanaan" },
  none: { title: "Arus kas belum terklasifikasi", total: "Jumlah belum terklasifikasi" },
};

export interface CashFlowFigures {
  byActivity: Record<CashFlowActivity, number>;
  netChange: number;
  openingCash: number;
  closingCash: number;
}

/** `cashBalances`: per cash account, [opening, closing] (debit − credit). */
export function buildCashFlowStatement(
  accounts: readonly StatementAccount[],
  allocation: CashFlowAllocation,
  cashBalances: ReadonlyMap<string, readonly [number, number]>,
  column: StatementColumn,
): Statement & { figures: CashFlowFigures } {
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const order = new Map(accounts.map((account, index) => [account.code, index]));
  const rows: StatementRow[] = [];
  const totals = { operating: 0, investing: 0, financing: 0, none: 0 } as Record<CashFlowActivity, number>;
  for (const activity of CASH_FLOW_ACTIVITY_GROUPS) {
    const items = [...allocation.byActivity[activity].entries()].filter(([, value]) => value !== 0).sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0) || a.localeCompare(b));
    totals[activity] = items.reduce((sum, [, value]) => sum + value, 0);
    if (activity === "none" && items.length === 0) continue;
    rows.push(section(activity, ACTIVITY_LABELS[activity].title, 1));
    for (const [code, value] of items) {
      const account = byCode.get(code);
      rows.push({ key: `${activity}:${code}`, label: account ? account.name : code, style: "account", depth: 1, amounts: [value], accountCode: code });
    }
    rows.push(sumRow(`${activity}:total`, ACTIVITY_LABELS[activity].total, [totals[activity]], "subtotal", 1));
  }
  const netChange = allocation.netChange;
  rows.push(sumRow("net_change", "Kenaikan (penurunan) kas bersih", [netChange], "total"));
  const cashAccounts = accounts.filter((account) => account.cashFlowGroup === "cash" && !account.isHeader && cashBalances.has(account.code));
  const openingCash = cashAccounts.reduce((sum, account) => sum + (cashBalances.get(account.code)?.[0] ?? 0), 0);
  const closingCash = cashAccounts.reduce((sum, account) => sum + (cashBalances.get(account.code)?.[1] ?? 0), 0);
  rows.push(sumRow("opening_cash", "Kas dan setara kas awal periode", [openingCash], "subtotal"));
  rows.push(sumRow("closing_cash", "Kas dan setara kas akhir periode", [closingCash], "total"));
  rows.push(section("cash_accounts", "Rincian kas dan setara kas akhir periode", 1));
  for (const account of cashAccounts) {
    const [, closing] = cashBalances.get(account.code) ?? [0, 0];
    if (closing === 0 && (cashBalances.get(account.code)?.[0] ?? 0) === 0) continue;
    rows.push({ key: `cash:${account.code}`, label: account.name, style: "account", depth: 1, amounts: [closing], accountCode: account.code });
  }
  const classified = CASH_FLOW_ACTIVITY_GROUPS.reduce((sum, activity) => sum + totals[activity], 0);
  const checks = [
    { label: "Kas awal ditambah kenaikan kas bersih sama dengan kas akhir", ok: openingCash + netChange === closingCash },
    { label: "Jumlah semua aktivitas sama dengan kenaikan kas bersih", ok: classified === netChange },
  ];
  return { columns: [column], rows, checks, figures: { byActivity: totals, netChange, openingCash, closingCash } };
}

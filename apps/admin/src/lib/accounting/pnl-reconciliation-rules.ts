import type { AccountType } from "@ammari/db/schema";

// Rekonsiliasi check 4 (docs/plans/accounting.md §6.3, Session 10): Laba rugi on the ledger vs the
// management P&L (§1.12: Ringkasan / Biaya tab "Laba rugi"). The pure half: which ledger account
// belongs to which management figure, and how a difference splits into lines that each have one
// cause. Every P&L account lands in exactly one component, so Σ component differences is exactly
// ledger laba bersih − management laba bersih: nothing can hide.

export const PNL_COMPONENTS = [
  "net_sales",
  "cogs",
  "platform_fees",
  "shipping",
  "courier_cost",
  "operating_expenses",
  "production_variance",
  "payment_gateway",
  "inventory_expense",
  "depreciation",
  "other_income",
  "other_expense",
  "tax",
] as const;
export type PnlComponent = (typeof PNL_COMPONENTS)[number];

/** +1: raises profit (shown as income); −1: lowers it (shown as a cost). */
export const COMPONENT_PROFIT_SIGN: Record<PnlComponent, 1 | -1> = {
  net_sales: 1,
  cogs: -1,
  platform_fees: -1,
  shipping: -1,
  courier_cost: -1,
  operating_expenses: -1,
  production_variance: -1,
  payment_gateway: -1,
  inventory_expense: -1,
  depreciation: -1,
  other_income: 1,
  other_expense: -1,
  tax: -1,
};

/** What the management figure is matched by: per order, per business expense, or nothing (the
 * management P&L has no such figure at all). */
export type ComponentKeyKind = "order" | "expense" | "none";
export const COMPONENT_KEY_KIND: Record<PnlComponent, ComponentKeyKind> = {
  net_sales: "order",
  cogs: "order",
  platform_fees: "order",
  shipping: "order",
  courier_cost: "none",
  operating_expenses: "expense",
  production_variance: "none",
  payment_gateway: "none",
  inventory_expense: "none",
  depreciation: "none",
  other_income: "none",
  other_expense: "none",
  tax: "none",
};

const SYSTEM_KEY_COMPONENT: Record<string, PnlComponent> = {
  "cogs.finished_goods": "cogs",
  "expense.marketplace_fee": "platform_fees",
  "expense.marketplace_shipping_subsidy": "platform_fees",
  "expense.payment_gateway": "payment_gateway",
  "expense.sales_shipping": "courier_cost",
  "expense.web_shipping_subsidy": "shipping",
  "expense.inventory_variance": "inventory_expense",
  "expense.inventory_loss": "inventory_expense",
  "expense.defect_release": "inventory_expense",
  "expense.depreciation": "depreciation",
};

export interface PnlAccount {
  code: string;
  type: AccountType;
  systemKey: string | null;
  parentCode: string | null;
}

/** The component of one postable P&L account; null for a balance-sheet account. A sub-account the
 * accountant adds under the Beban persediaan header (6-4000) is inventory expense too. */
export function componentOfAccount(account: PnlAccount, inventoryHeaders: ReadonlySet<string>): PnlComponent | null {
  switch (account.type) {
    case "revenue":
    case "contra_revenue":
      return "net_sales";
    case "cogs":
      return account.systemKey === "cogs.finished_goods" ? "cogs" : "production_variance";
    case "expense": {
      const bySystemKey = account.systemKey ? SYSTEM_KEY_COMPONENT[account.systemKey] : undefined;
      if (bySystemKey) return bySystemKey;
      if (account.parentCode && inventoryHeaders.has(account.parentCode)) return "inventory_expense";
      return "operating_expenses";
    }
    case "other_income":
      return "other_income";
    case "other_expense":
      return "other_expense";
    case "tax":
      return "tax";
    default:
      return null;
  }
}

export type DifferenceClass = "app_only" | "ledger_only" | "amount" | "outside";

export interface DifferenceLine {
  cls: DifferenceClass;
  /** ledger − management, on the component's own side. */
  amount: number;
  count: number;
  /** A few keys (order or expense ids) for links. */
  sampleKeys: string[];
}

export interface ComponentReconciliation {
  component: PnlComponent;
  management: number;
  ledger: number;
  difference: number;
  lines: DifferenceLine[];
}

export const SAMPLE_KEYS = 5;

/**
 * One component: per key (order / expense) the management amount against the ledger amount, plus
 * the ledger lines carrying no key (manual, opening-free adjustments). Amounts are on the
 * component's natural side (sales as income, costs as costs). The lines add up to the difference
 * exactly.
 */
export function reconcileComponent(input: {
  component: PnlComponent;
  management: ReadonlyMap<string, number>;
  ledgerByKey: ReadonlyMap<string, number>;
  ledgerOutside: number;
}): ComponentReconciliation {
  const lines: Record<DifferenceClass, DifferenceLine> = {
    app_only: { cls: "app_only", amount: 0, count: 0, sampleKeys: [] },
    ledger_only: { cls: "ledger_only", amount: 0, count: 0, sampleKeys: [] },
    amount: { cls: "amount", amount: 0, count: 0, sampleKeys: [] },
    outside: { cls: "outside", amount: input.ledgerOutside, count: 0, sampleKeys: [] },
  };
  let management = 0;
  let ledger = input.ledgerOutside;
  const keys = [...new Set([...input.management.keys(), ...input.ledgerByKey.keys()])].sort();
  for (const key of keys) {
    const app = input.management.get(key) ?? 0;
    const booked = input.ledgerByKey.get(key) ?? 0;
    management += app;
    ledger += booked;
    if (app === booked) continue;
    const line = lines[app !== 0 && booked === 0 ? "app_only" : booked !== 0 && app === 0 ? "ledger_only" : "amount"];
    line.amount += booked - app;
    line.count += 1;
    if (line.sampleKeys.length < SAMPLE_KEYS) line.sampleKeys.push(key);
  }
  return {
    component: input.component,
    management,
    ledger,
    difference: ledger - management,
    lines: Object.values(lines).filter((line) => line.amount !== 0 || line.count > 0),
  };
}

export const COMPONENT_LABELS: Record<PnlComponent, string> = {
  net_sales: "Penjualan bersih (omzet)",
  cogs: "HPP barang jadi",
  platform_fees: "Biaya platform marketplace dan subsidi ongkir penjual",
  shipping: "Subsidi ongkir website",
  courier_cost: "Beban ongkos kirim penjualan (selisih tarif kurir, ongkir retur)",
  operating_expenses: "Biaya usaha (catatan Biaya)",
  production_variance: "Selisih biaya produksi dan HPP lainnya",
  payment_gateway: "Biaya payment gateway (MDR)",
  inventory_expense: "Beban persediaan (selisih, kerusakan, barang cacat)",
  depreciation: "Beban penyusutan",
  other_income: "Pendapatan lain-lain",
  other_expense: "Beban lain-lain",
  tax: "PPh final",
};

/** Why the management P&L has no figure for a "none" component. */
export const NOT_IN_MANAGEMENT_REASON: Partial<Record<PnlComponent, string>> = {
  production_variance: "Laporan manajemen memakai HPP pesanan saja; sisa pembulatan batch produksi (dan akun HPP lain) tidak dihitung.",
  courier_cost: "Laporan manajemen hanya menghitung subsidi ongkir website; selisih tarif kurir dengan tarif checkout dan ongkir retur tidak dihitung.",
  payment_gateway: "Biaya Midtrans belum tercatat di laporan manajemen.",
  inventory_expense: "Selisih opname, barang rusak atau hilang, dan barang cacat yang dilepas tidak masuk laporan manajemen.",
  depreciation: "Laporan manajemen tidak menghitung penyusutan aset tetap.",
  other_income: "Laporan manajemen tidak mencatat pendapatan lain-lain (mis. hasil lelang barang cacat).",
  other_expense: "Laporan manajemen tidak mencatat beban lain-lain.",
  tax: "Laporan manajemen tidak menghitung PPh final.",
};

/** The line text per key kind and class. */
export function differenceLabel(kind: ComponentKeyKind, cls: DifferenceClass): string {
  if (cls === "outside") return kind === "none" ? "Jurnal di buku besar" : kind === "order" ? "Jurnal tanpa pesanan (jurnal manual atau penyesuaian)" : "Jurnal tanpa catatan biaya (jurnal manual, akrual, dibayar di muka)";
  if (kind === "order") {
    if (cls === "app_only") return "Pesanan dengan tanggal pesan di periode ini yang tidak diakui di buku besar periode ini (diakui saat dikirim, belum dikirim, menunggu data, atau sebelum pembukuan)";
    if (cls === "ledger_only") return "Pesanan yang diakui di buku besar periode ini tetapi dipesan di periode lain, atau sudah dibatalkan atau diretur";
    return "Nilai berbeda pada pesanan yang sama (refund sebagian, retur, ongkir kurir, atau pembulatan HPP)";
  }
  if (cls === "app_only") return "Biaya di laporan manajemen yang tidak dibukukan ke beban ini (dipetakan ke akun lain, belum diposting, atau sebelum pembukuan)";
  if (cls === "ledger_only") return "Biaya yang dibukukan di periode ini tetapi tidak dihitung laporan manajemen (dibatalkan, atau tanggal lain)";
  return "Nilai berbeda pada biaya yang sama";
}

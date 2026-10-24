import { columnSpecId, type ChannelFeeComponent, type ColumnSpec, type FeeAmounts } from "./adapters/types";
import { fileError, type FileResult } from "./errors";
import { normalizeHeader } from "./headers";
import { MAX_DATA_ROWS, MAX_ORDERS } from "./limits";
import type { Cell } from "./read-sheet";
import { parseChannelOrderNo, parseJakartaDateTime, parseMoney, parseQty, parseSku, type ParseResult } from "./values";

// Rows -> orders (docs/plans/marketplace-import.md §4). Marketplace exports have one row per item,
// with order-level values (status, time, voucher, most fees) repeated on every row. Each column's
// scope says how it is combined: `order` values are taken ONCE and must agree across the order's
// rows (blanks ignored); `line` values are summed. Rows of one order with the same SKU are merged
// into one line (SPEC §5.2). Only mapped columns are ever read, so buyer data never leaves here.

export interface ImportLine {
  /** Uppercased marketplace SKU; null when the cell was blank (always an unknown SKU later). */
  sku: string | null;
  qty: number;
  /** round(lineTotal / qty), the weighted average of merged rows. */
  unitPrice: number;
  /** Sum of the rows' charged amounts, as in the file. */
  lineTotal: number;
  rowNumbers: number[];
  /** Product / variation names from the file, display only (owner addition A): never stored, never
   * used to match a SKU. */
  nameHints: string[];
}

export interface ImportOrder {
  channelOrderNo: string;
  /** As written in the file (trimmed), for display and orders.channel_status. */
  rawStatus: string;
  /** `normalizeHeader(rawStatus)`, the adapter's statusMap key. */
  statusKey: string;
  orderedAt: Date;
  lines: ImportLine[];
  /** sum(qty x unitPrice): what the order's lines add up to in admin. */
  subtotalAmount: number;
  /** sum(lineTotal) - subtotalAmount; a few rupiah from merged-line rounding. */
  roundingDifference: number;
  sellerVoucherAmount: number;
  fees: FeeAmounts;
  rowNumbers: number[];
}

export type OrderProblemCode = "invalid_rows" | "inconsistent_values" | "missing_value" | "voucher_exceeds_subtotal";

/** An order kept out of the import, with why. The rest of the file is unaffected. */
export interface OrderProblem {
  channelOrderNo: string;
  rowNumbers: number[];
  code: OrderProblemCode;
  message: string;
}

/** One unusable cell. `rowNumber` is the spreadsheet's own 1-based row number. */
export interface RowError {
  rowNumber: number;
  columnLabel: string | null;
  message: string;
}

export interface GroupedOrders {
  orders: ImportOrder[];
  problems: OrderProblem[];
  rowErrors: RowError[];
  dataRowCount: number;
  /** Rows whose mapped columns were all blank (e.g. a summary or spacer row), skipped. */
  blankRowCount: number;
  /** Rows with data but no usable order number. Such a row may be an item of ANY order in the file
   * (an order would then import short), so while this is above 0 nothing in the file may be saved
   * (parse-file.ts `saveBlockers`). Found by the session 1 review. */
  unattributedRowCount: number;
}

const MAX_NAME_HINTS = 3;
const MAX_NAME_HINT_CHARS = 120;

type OrderValue = string | number;

interface OrderDraft {
  channelOrderNo: string;
  rowNumbers: number[];
  invalidRows: number[];
  /** Spec id -> the distinct non-blank values seen (canonical form), and the first raw text. */
  orderValues: Map<string, { values: Set<OrderValue>; first: OrderValue }>;
  lines: Map<string, ImportLine>;
  lineFees: FeeAmounts;
  /** A line-scope voucher column's rows, summed (none for Shopee). */
  lineVoucher: number;
}

interface Column {
  spec: ColumnSpec;
  index: number;
}

export interface GroupInput {
  rows: readonly Cell[][];
  headerRowIndex: number;
  columns: ReadonlyMap<string, number>;
  specs: readonly ColumnSpec[];
  date1904: boolean;
}

function isBlankCell(cell: Cell | undefined): boolean {
  return cell === undefined || cell === null || (typeof cell === "string" && cell.trim() === "");
}

function addFee(target: FeeAmounts, component: ChannelFeeComponent, amount: number): void {
  target[component] = (target[component] ?? 0) + amount;
}

export function groupOrders(input: GroupInput): FileResult<GroupedOrders> {
  const mapped: Column[] = [];
  for (const spec of input.specs) {
    const index = input.columns.get(columnSpecId(spec));
    if (index !== undefined) mapped.push({ spec, index });
  }
  const orderNoColumn = mapped.find((column) => column.spec.field === "channelOrderNo");
  if (!orderNoColumn) throw new Error("groupOrders needs the order number column (locateHeader guarantees it)");

  const dataRows = input.rows.slice(input.headerRowIndex + 1);
  if (dataRows.length > MAX_DATA_ROWS) {
    return fileError("too_many_rows", `Terlalu banyak baris (maks. ${MAX_DATA_ROWS.toLocaleString("id-ID")}). Export per rentang tanggal yang lebih pendek.`);
  }

  const drafts = new Map<string, OrderDraft>();
  const rowErrors: RowError[] = [];
  let blankRowCount = 0;
  let unattributedRowCount = 0;

  dataRows.forEach((row, offset) => {
    const rowNumber = input.headerRowIndex + 2 + offset;
    if (mapped.every((column) => isBlankCell(row[column.index]))) {
      blankRowCount++;
      return;
    }

    const orderNo = parseChannelOrderNo(row[orderNoColumn.index] ?? null);
    if (!orderNo.ok) {
      rowErrors.push({ rowNumber, columnLabel: orderNoColumn.spec.label, message: orderNo.message });
      unattributedRowCount++;
      return;
    }
    let draft = drafts.get(orderNo.value);
    if (!draft) {
      draft = { channelOrderNo: orderNo.value, rowNumbers: [], invalidRows: [], orderValues: new Map(), lines: new Map(), lineFees: {}, lineVoucher: 0 };
      drafts.set(orderNo.value, draft);
    }
    draft.rowNumbers.push(rowNumber);

    let rowValid = true;
    const reject = (column: Column, message: string) => {
      rowErrors.push({ rowNumber, columnLabel: column.spec.label, message });
      rowValid = false;
    };
    const take = <T>(column: Column | undefined, parse: (cell: Cell) => ParseResult<T>): T | undefined => {
      if (!column) return undefined;
      const result = parse(row[column.index] ?? null);
      if (!result.ok) {
        reject(column, result.message);
        return undefined;
      }
      return result.value;
    };
    const columnFor = (predicate: (spec: ColumnSpec) => boolean) => mapped.find((column) => predicate(column.spec));

    // Line values.
    const sku = take(columnFor((spec) => spec.field === "sku"), parseSku);
    const qty = take(columnFor((spec) => spec.field === "qty"), parseQty);
    const lineTotalColumn = columnFor((spec) => spec.field === "lineTotal");
    const lineTotal = take(lineTotalColumn, parseMoney);
    if (lineTotalColumn && lineTotal === null) reject(lineTotalColumn, "Total harga produk kosong.");
    const hints = mapped
      .filter((column) => column.spec.field === "productName" || column.spec.field === "variationName")
      .map((column) => row[column.index])
      .filter((cell): cell is string => typeof cell === "string" && cell.trim() !== "")
      .map((cell) => cell.trim().slice(0, MAX_NAME_HINT_CHARS));
    const lineFees: FeeAmounts = {};
    let lineVoucher = 0;
    for (const column of mapped) {
      const { spec } = column;
      if ((spec.field !== "fee" && spec.field !== "sellerVoucher") || spec.scope !== "line") continue;
      const amount = take(column, parseMoney) ?? 0;
      if (spec.field === "fee") addFee(lineFees, spec.component, amount);
      else lineVoucher += amount;
    }

    // Order values, kept as canonical values to compare across rows.
    for (const column of mapped) {
      const { spec } = column;
      let value: OrderValue | null | undefined;
      if (spec.field === "status") {
        const cell = row[column.index];
        // A text that normalizes to nothing (e.g. "(Rp)") has no status key: invalid, not blank.
        value = isBlankCell(cell) ? null : typeof cell === "string" && normalizeHeader(cell) !== null ? cell.trim() : undefined;
        if (value === undefined) reject(column, "Status pesanan tidak valid.");
      } else if (spec.field === "orderedAt") {
        const cell = row[column.index] ?? null;
        value = isBlankCell(cell) ? null : take(column, (c) => parseJakartaDateTime(c, input.date1904))?.getTime();
      } else if ((spec.field === "sellerVoucher" || spec.field === "fee") && spec.scope === "order") {
        value = take(column, parseMoney);
      } else {
        continue;
      }
      if (value === null || value === undefined) continue;
      const id = columnSpecId(spec);
      const seen = draft.orderValues.get(id);
      const key = spec.field === "status" ? normalizeHeader(value as string)! : value;
      if (seen) seen.values.add(key);
      else draft.orderValues.set(id, { values: new Set([key]), first: value });
    }

    if (!rowValid || qty === undefined || lineTotal === undefined || lineTotal === null || sku === undefined) {
      draft.invalidRows.push(rowNumber);
      return;
    }
    const lineKey = sku ?? "";
    const line = draft.lines.get(lineKey);
    if (line) {
      line.qty += qty;
      line.lineTotal += lineTotal;
      line.rowNumbers.push(rowNumber);
      for (const hint of hints) if (!line.nameHints.includes(hint) && line.nameHints.length < MAX_NAME_HINTS) line.nameHints.push(hint);
    } else {
      draft.lines.set(lineKey, { sku, qty, unitPrice: 0, lineTotal, rowNumbers: [rowNumber], nameHints: hints.slice(0, MAX_NAME_HINTS) });
    }
    for (const [component, amount] of Object.entries(lineFees) as [ChannelFeeComponent, number][]) addFee(draft.lineFees, component, amount);
    draft.lineVoucher += lineVoucher;
  });

  if (drafts.size > MAX_ORDERS) {
    return fileError("too_many_orders", `Terlalu banyak pesanan dalam satu file (maks. ${MAX_ORDERS.toLocaleString("id-ID")}). Export per rentang tanggal yang lebih pendek.`);
  }

  const orders: ImportOrder[] = [];
  const problems: OrderProblem[] = [];
  for (const draft of drafts.values()) {
    const result = finishOrder(draft, mapped);
    if ("problem" in result) problems.push(result.problem);
    else orders.push(result.order);
  }
  return { ok: true, value: { orders, problems, rowErrors, dataRowCount: dataRows.length - blankRowCount, blankRowCount, unattributedRowCount } };
}

function finishOrder(draft: OrderDraft, mapped: readonly Column[]): { order: ImportOrder } | { problem: OrderProblem } {
  const problem = (code: OrderProblemCode, message: string) => ({ problem: { channelOrderNo: draft.channelOrderNo, rowNumbers: draft.rowNumbers, code, message } });

  if (draft.invalidRows.length > 0) {
    return problem("invalid_rows", `Ada baris yang tidak valid di pesanan ini (baris ${draft.invalidRows.join(", ")}), jadi pesanan belum diimpor.`);
  }

  const inconsistent = mapped.filter((column) => (draft.orderValues.get(columnSpecId(column.spec))?.values.size ?? 0) > 1);
  if (inconsistent.length > 0) {
    return problem("inconsistent_values", `Nilai ${inconsistent.map((column) => column.spec.label).join(", ")} berbeda antar baris pesanan ini, jadi pesanan belum diimpor.`);
  }

  const single = (field: "status" | "orderedAt" | "sellerVoucher") => draft.orderValues.get(field)?.first;
  const rawStatus = single("status");
  const orderedAt = single("orderedAt");
  if (rawStatus === undefined || orderedAt === undefined) {
    const label = mapped.find((column) => column.spec.field === (rawStatus === undefined ? "status" : "orderedAt"))!.spec.label;
    return problem("missing_value", `${label} kosong untuk pesanan ini, jadi pesanan belum diimpor.`);
  }

  const lines = [...draft.lines.values()].map((line) => ({ ...line, unitPrice: Math.round(line.lineTotal / line.qty) }));
  const subtotalAmount = lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  const roundingDifference = lines.reduce((sum, line) => sum + line.lineTotal, 0) - subtotalAmount;
  // A present voucher column with blank cells means no voucher (the column itself is required for
  // Shopee, so a missing one never reaches this point).
  const sellerVoucherAmount = ((single("sellerVoucher") as number | undefined) ?? 0) + draft.lineVoucher;
  if (sellerVoucherAmount > subtotalAmount) {
    return problem("voucher_exceeds_subtotal", "Voucher penjual lebih besar dari total harga produk, jadi pesanan belum diimpor.");
  }

  const fees: FeeAmounts = { ...draft.lineFees };
  for (const column of mapped) {
    if (column.spec.field !== "fee") continue;
    const component = column.spec.component;
    if (column.spec.scope === "order") addFee(fees, component, (draft.orderValues.get(columnSpecId(column.spec))?.first as number | undefined) ?? 0);
    // A present column with only blank cells is a fee of 0, not a missing fee.
    else fees[component] ??= 0;
  }

  return {
    order: {
      channelOrderNo: draft.channelOrderNo,
      rawStatus: rawStatus as string,
      statusKey: normalizeHeader(rawStatus as string)!,
      orderedAt: new Date(orderedAt as number),
      lines,
      subtotalAmount,
      roundingDifference,
      sellerVoucherAmount,
      fees,
      rowNumbers: draft.rowNumbers,
    },
  };
}

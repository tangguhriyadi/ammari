import { columnSpecId, type ChannelFeeComponent, type ColumnSpec, type FeeAmounts, type SellerDiscountField } from "./adapters/types";
import { fileError, type FileResult } from "./errors";
import { normalizeHeader } from "./headers";
import { MAX_DATA_ROWS, MAX_ORDERS } from "./limits";
import type { Cell } from "./read-sheet";
import { parseChannelOrderNo, parseCountText, parseJakartaMinuteText, parseQtyText, MAX_RUPIAH_CELL, parseRupiahText, parseSkuText, parseYesNoText, type ParseResult } from "./values";

// Rows -> orders (docs/plans/marketplace-import.md §4, §19.2). Marketplace exports have one row per
// item, with order-level values (status, time, voucher) repeated on every row. Each column's scope
// says how it is combined: `order` values are taken ONCE and must agree across the order's rows
// (blanks ignored); `line` values are summed. Rows of one order with the same SKU are merged into
// one line (SPEC §5.2). Only mapped columns are ever read, so buyer data never leaves here.
//
// Cells are parsed as the real Shopee export writes them, text only (§19.1): a number cell, a
// decimal or a time with seconds is a row error. Nothing here decides whether an order is held for
// a cancel/return status, returned goods or prices that do not add up: those facts are carried to
// the planner (plan.ts), which lists every reason an order waits in Perlu dicek.

export interface ImportLine {
  /** Uppercased marketplace SKU; null when the cell was blank (always an unknown SKU later). */
  sku: string | null;
  qty: number;
  /** round(lineTotal / qty), the weighted average of merged rows' Harga Awal. */
  unitPrice: number;
  /** Sum of the rows' Harga Awal x Jumlah (the revenue basis, owner Q3), computed in integers. */
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
  /** Seller-funded money only (D-4): Diskon Dari Penjual (summed over rows), Voucher Ditanggung
   * Penjual and Paket Diskon (Diskon dari Penjual), each taken per its scope. Shopee-funded money is
   * never read: it counts in revenue (owner Q3). */
  sellerDiscounts: { product: number; voucher: number; bundle: number };
  /** product + voucher + bundle: what discount_amount becomes. */
  sellerDiscountAmount: number;
  /** Status Pembatalan/ Pengembalian (trimmed), null when blank. Any value holds the order (§19.4). */
  cancelReturnStatus: string | null;
  /** Sum of Returned quantity over the order's rows (blank = 0). Above 0 holds the order. */
  returnedQty: number;
  /** Rows whose prices do not add up (§19.2 price check). Any holds the order; never repaired. */
  priceMismatchRows: number[];
  /** Subtotal Pesanan per row, as in the file (scope unverified, O1-b): display only. */
  fileSubtotals: number[];
  /** Rows where any guarded discount column is non-zero (Total Diskon, Diskon Dari Penjual, Diskon
   * Dari Shopee, Voucher Ditanggung Penjual, Voucher Ditanggung Shopee, Paket Diskon = Y, both Paket
   * Diskon amounts, Potongan Koin Shopee). On an order of more than one row this holds the order
   * (plan §19.9 7c): whether order-level amounts repeat per row is unverified (O1-a/O1-b). */
  discountedRowNumbers: number[];
  /** Waktu Pengiriman Diatur (Jakarta, as its UTC instant), null when blank. Carried whatever the
   * status: the planner stores it only once the marketplace says shipped (plan §19.3). */
  shippedAt: Date | null;
  /** Waktu Pesanan Selesai, null when blank; the planner stores it only on Selesai. */
  completedAt: Date | null;
  fees: FeeAmounts;
  rowNumbers: number[];
}

export type OrderProblemCode = "invalid_rows" | "inconsistent_values" | "missing_value" | "voucher_exceeds_subtotal";

const DISCOUNT_KEY: Record<SellerDiscountField, keyof ImportOrder["sellerDiscounts"]> = {
  sellerProductDiscount: "product",
  sellerVoucher: "voucher",
  sellerBundleDiscount: "bundle",
};

function isSellerDiscount(spec: ColumnSpec): spec is Extract<ColumnSpec, { field: SellerDiscountField }> {
  return spec.field === "sellerVoucher" || spec.field === "sellerProductDiscount" || spec.field === "sellerBundleDiscount";
}

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

export const SELLER_DISCOUNT_EXCEEDS_SUBTOTAL = "Diskon penjual (voucher, diskon produk dan paket diskon) lebih besar dari total harga produk, jadi pesanan belum diimpor.";

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
  /** Line-scope seller discount columns, summed over the rows. */
  lineDiscounts: ImportOrder["sellerDiscounts"];
  returnedQty: number;
  priceMismatchRows: number[];
  fileSubtotals: number[];
  discountedRowNumbers: number[];
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
  /** The upload time: a ship or complete time more than MAX_FUTURE_MS after it is a row error. */
  now: Date;
}

/** A marketplace time may run ahead of our clock by at most this much (plan §19.3). */
export const MAX_FUTURE_MS = 60 * 60 * 1000;

type TimeField = "orderedAt" | "shippedAt" | "completedAt";
const TIME_FIELDS: readonly ColumnSpec["field"][] = ["orderedAt", "shippedAt", "completedAt"];

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
      draft = {
        channelOrderNo: orderNo.value,
        rowNumbers: [],
        invalidRows: [],
        orderValues: new Map(),
        lines: new Map(),
        lineFees: {},
        lineDiscounts: { product: 0, voucher: 0, bundle: 0 },
        returnedQty: 0,
        priceMismatchRows: [],
        fileSubtotals: [],
        discountedRowNumbers: [],
      };
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
    const money = (column: Column | undefined) => take(column, (cell) => parseRupiahText(cell, column!.spec.label));
    const requiredMoney = (column: Column | undefined) => {
      const value = money(column);
      if (column && value === null) reject(column, `${column.spec.label} kosong.`);
      return value ?? undefined;
    };
    const columnOf = (field: ColumnSpec["field"]) => columnFor((spec) => spec.field === field);
    const sku = take(columnOf("sku"), parseSkuText);
    const qty = take(columnOf("qty"), parseQtyText);
    const listUnitPrice = requiredMoney(columnOf("listUnitPrice"));
    const afterColumn = columnOf("unitPriceAfterDiscount");
    const unitPriceAfterDiscount = requiredMoney(afterColumn);
    const totalDiscountColumn = columnOf("totalDiscount");
    const totalDiscount = money(totalDiscountColumn);
    const shopeeDiscountColumn = columnOf("shopeeProductDiscount");
    const shopeeDiscount = money(shopeeDiscountColumn);
    const returnedColumn = columnOf("returnedQty");
    const returned = take(returnedColumn, (cell) => parseCountText(cell, returnedColumn!.spec.label));
    const fileSubtotal = money(columnOf("fileSubtotal"));
    // Guard-only columns (7c): read once here, never written.
    const shopeeVoucher = money(columnOf("shopeeVoucher"));
    const shopeeBundleDiscount = money(columnOf("shopeeBundleDiscount"));
    const shopeeCoinDiscount = money(columnOf("shopeeCoinDiscount"));
    const bundleFlagColumn = columnOf("bundleFlag");
    const bundleFlag = take(bundleFlagColumn, (cell) => parseYesNoText(cell, bundleFlagColumn!.spec.label));
    let rowDiscounted = bundleFlag === true || [totalDiscount, shopeeDiscount, shopeeVoucher, shopeeBundleDiscount, shopeeCoinDiscount].some((amount) => (amount ?? 0) > 0);
    let lineTotal: number | undefined;
    if (qty !== undefined && listUnitPrice !== undefined) {
      lineTotal = listUnitPrice * qty;
      // Capped like one cell, so merged lines and order sums stay exact (MAX_RUPIAH_CELL).
      if (lineTotal > MAX_RUPIAH_CELL) {
        reject(columnOf("listUnitPrice")!, "Angka uang terlalu besar.");
        lineTotal = undefined;
      }
    }
    const hints = mapped
      .filter((column) => column.spec.field === "productName" || column.spec.field === "variationName")
      .map((column) => row[column.index])
      .filter((cell): cell is string => typeof cell === "string" && cell.trim() !== "")
      .map((cell) => cell.trim().slice(0, MAX_NAME_HINT_CHARS));
    const lineFees: FeeAmounts = {};
    const lineDiscounts = { product: 0, voucher: 0, bundle: 0 };
    let sellerLineDiscount: number | null = null;
    for (const column of mapped) {
      const { spec } = column;
      if (spec.field === "fee" && spec.scope === "line") addFee(lineFees, spec.component, money(column) ?? 0);
      if (isSellerDiscount(spec) && spec.scope === "line") {
        const amount = money(column) ?? 0;
        lineDiscounts[DISCOUNT_KEY[spec.field]] += amount;
        if (spec.field === "sellerProductDiscount") sellerLineDiscount = amount;
        if (amount > 0) rowDiscounted = true;
      }
    }

    // Order values, kept as canonical values to compare across rows.
    const rowTimes: Partial<Record<TimeField, { value: number; column: Column }>> = {};
    for (const column of mapped) {
      const { spec } = column;
      let value: OrderValue | null | undefined;
      if (spec.field === "status") {
        const cell = row[column.index];
        // A text that normalizes to nothing (e.g. "(Rp)") has no status key: invalid, not blank.
        value = isBlankCell(cell) ? null : typeof cell === "string" && normalizeHeader(cell) !== null ? cell.trim() : undefined;
        if (value === undefined) reject(column, "Status pesanan tidak valid.");
      } else if (spec.field === "cancelReturnStatus") {
        const cell = row[column.index];
        value = isBlankCell(cell) ? null : typeof cell === "string" && normalizeHeader(cell) !== null ? cell.trim() : undefined;
        if (value === undefined) reject(column, `${spec.label} tidak valid.`);
      } else if (spec.field === "orderedAt" || spec.field === "shippedAt" || spec.field === "completedAt") {
        const cell = row[column.index] ?? null;
        value = isBlankCell(cell) ? null : take(column, (c) => parseJakartaMinuteText(c, spec.label))?.getTime();
        if (typeof value === "number") rowTimes[spec.field] = { value, column };
      } else if ((isSellerDiscount(spec) || spec.field === "fee") && spec.scope === "order") {
        value = money(column);
        if (isSellerDiscount(spec) && typeof value === "number" && value > 0) rowDiscounted = true;
      } else {
        continue;
      }
      if (value === null || value === undefined) continue;
      const id = columnSpecId(spec);
      const seen = draft.orderValues.get(id);
      const key = spec.field === "status" || spec.field === "cancelReturnStatus" ? normalizeHeader(value as string)! : value;
      if (seen) seen.values.add(key);
      else draft.orderValues.set(id, { values: new Set([key]), first: value });
    }

    // orderedAt <= shippedAt <= completedAt on the row, and neither more than an hour after the upload
    // (plan §19.3): a row error, never a silent NULL. Only between values this row itself carries; the
    // order-level backstop in finishOrder covers values split across rows.
    for (const message of timeOrderProblems(rowTimes, input.now)) reject(message.column, message.text);

    if (!rowValid || qty === undefined || lineTotal === undefined || sku === undefined || listUnitPrice === undefined || (afterColumn && unitPriceAfterDiscount === undefined)) {
      draft.invalidRows.push(rowNumber);
      return;
    }

    // Price check (§19.2), only when every column it needs is in the file. A hypothesis until O1-d
    // confirms it on a discounted order; a row that breaks it is recorded, never repaired.
    if (unitPriceAfterDiscount !== undefined && totalDiscountColumn && shopeeDiscountColumn && sellerLineDiscount !== null) {
      const total = totalDiscount ?? 0;
      if (lineTotal - total !== unitPriceAfterDiscount * qty || total !== sellerLineDiscount + (shopeeDiscount ?? 0)) draft.priceMismatchRows.push(rowNumber);
    }
    draft.returnedQty += returned ?? 0;
    if (rowDiscounted) draft.discountedRowNumbers.push(rowNumber);
    if (fileSubtotal !== null && fileSubtotal !== undefined) draft.fileSubtotals.push(fileSubtotal);

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
    for (const key of Object.keys(lineDiscounts) as (keyof typeof lineDiscounts)[]) draft.lineDiscounts[key] += lineDiscounts[key];
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

  const single = (id: string) => draft.orderValues.get(id)?.first;
  const rawStatus = single("status");
  const orderedAt = single("orderedAt");
  if (rawStatus === undefined || orderedAt === undefined) {
    const label = mapped.find((column) => column.spec.field === (rawStatus === undefined ? "status" : "orderedAt"))!.spec.label;
    return problem("missing_value", `${label} kosong untuk pesanan ini, jadi pesanan belum diimpor.`);
  }

  // Times split across rows (e.g. a ship time on the first row only, O1-a) are checked once more as
  // the order's values; each row's own values were checked in the row loop.
  const orderTimes: Partial<Record<TimeField, { value: number; column: Column }>> = {};
  for (const column of mapped) {
    const field = column.spec.field;
    if (!TIME_FIELDS.includes(field)) continue;
    const value = single(columnSpecId(column.spec));
    if (typeof value === "number") orderTimes[field as TimeField] = { value, column };
  }
  const timeProblems = timeOrderProblems(orderTimes, null);
  if (timeProblems.length > 0) return problem("invalid_rows", `${timeProblems.map((entry) => entry.text).join(" ")} Pesanan belum diimpor.`);

  const lines = [...draft.lines.values()].map((line) => ({ ...line, unitPrice: Math.round(line.lineTotal / line.qty) }));
  const subtotalAmount = lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  const roundingDifference = lines.reduce((sum, line) => sum + line.lineTotal, 0) - subtotalAmount;
  // A present discount column with blank cells means no discount (the columns are required for
  // Shopee, so a missing one never reaches this point).
  const sellerDiscounts = { ...draft.lineDiscounts };
  for (const column of mapped) {
    if (isSellerDiscount(column.spec) && column.spec.scope === "order") {
      sellerDiscounts[DISCOUNT_KEY[column.spec.field]] += (single(columnSpecId(column.spec)) as number | undefined) ?? 0;
    }
  }
  const sellerDiscountAmount = sellerDiscounts.product + sellerDiscounts.voucher + sellerDiscounts.bundle;
  if (sellerDiscountAmount > subtotalAmount) {
    return problem("voucher_exceeds_subtotal", SELLER_DISCOUNT_EXCEEDS_SUBTOTAL);
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
      sellerDiscounts,
      sellerDiscountAmount,
      cancelReturnStatus: (single("cancelReturnStatus") as string | undefined) ?? null,
      returnedQty: draft.returnedQty,
      priceMismatchRows: draft.priceMismatchRows,
      fileSubtotals: draft.fileSubtotals,
      discountedRowNumbers: draft.discountedRowNumbers,
      shippedAt: timeOf(single("shippedAt")),
      completedAt: timeOf(single("completedAt")),
      fees,
      rowNumbers: draft.rowNumbers,
    },
  };
}

function timeOf(value: OrderValue | undefined): Date | null {
  return typeof value === "number" ? new Date(value) : null;
}

/** What is wrong with a set of order times (plan §19.3): out of order, or (with `now`) a ship or
 * complete time more than an hour after the upload. Waktu Pesanan Dibuat is 7a's column and is not
 * held to the upload time (existing tests date orders years ahead on purpose). Messages name the columns by their Seller Center labels. */
function timeOrderProblems(times: Partial<Record<TimeField, { value: number; column: Column }>>, now: Date | null): { column: Column; text: string }[] {
  const out: { column: Column; text: string }[] = [];
  const { orderedAt, shippedAt, completedAt } = times;
  const before = (later: { value: number; column: Column }, earlier: { value: number; column: Column }) => {
    if (later.value < earlier.value) out.push({ column: later.column, text: `${later.column.spec.label} lebih awal dari ${earlier.column.spec.label}.` });
  };
  if (shippedAt && orderedAt) before(shippedAt, orderedAt);
  if (completedAt && shippedAt) before(completedAt, shippedAt);
  else if (completedAt && orderedAt) before(completedAt, orderedAt);
  if (now) {
    for (const time of [shippedAt, completedAt]) {
      if (time && time.value > now.getTime() + MAX_FUTURE_MS) out.push({ column: time.column, text: `${time.column.spec.label} lebih dari 1 jam setelah waktu upload.` });
    }
  }
  return out;
}

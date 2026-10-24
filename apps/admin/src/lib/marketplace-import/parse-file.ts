import "server-only";
import { createHash } from "node:crypto";
import { adapterFor } from "./adapters";
import type { MarketplaceAdapter } from "./adapters/types";
import { fileError, type FileResult, type ImportFileError } from "./errors";
import { groupOrders, type ImportOrder, type OrderProblem, type RowError } from "./group-orders";
import { locateHeader, type HeaderMatch } from "./headers";
import { readSpreadsheet, type SheetRows } from "./read-sheet";

// The session 1 entry point of the marketplace import (docs/plans/marketplace-import.md §1, §2):
// one uploaded file -> the orders in it, what is wrong with the rest, and whether this channel may
// save yet. Read-only; nothing here touches the database. The planner (session 3) compares the
// result with admin and the commit (session 4) writes it.

/** Row errors listed in full; the rest are only counted (the preview stays small). */
export const MAX_LISTED_ROW_ERRORS = 200;

export interface ParsedImport {
  channelId: MarketplaceAdapter["channelId"];
  channelLabel: string;
  /** false: preview only, Simpan refused (owner decision 14). */
  mappingVerified: boolean;
  lockedMessage: string | null;
  /** Every reason NOTHING in this file may be saved (the lock above, rows that belong to no order).
   * Empty = the ready orders may be saved. The commit (session 4) refuses on the server while it is
   * not empty, whatever the browser sends. */
  saveBlockers: string[];
  /** sha256 of the uploaded bytes, hex; the batch records it at Simpan (plan §1). */
  fileSha256: string;
  format: "xlsx" | "csv";
  sheetName: string;
  /** 1-based, as the spreadsheet shows it. */
  headerRowNumber: number;
  dataRowCount: number;
  blankRowCount: number;
  /** Rows with data but no usable order number (group-orders.ts). */
  unattributedRowCount: number;
  orders: ImportOrder[];
  problems: OrderProblem[];
  rowErrors: RowError[];
  rowErrorCount: number;
  /** Status texts the adapter does not know, with how many orders carry each (plan §3). */
  unknownStatuses: { rawStatus: string; orderCount: number }[];
  warnings: string[];
  /** Earliest and latest order time among `orders`, or null when there are none. */
  orderedAtRange: { from: Date; to: Date } | null;
}

export interface ParseFileInput {
  channelId: string;
  fileName: string;
  bytes: Uint8Array;
}

/** The first sheet whose header matches; otherwise the most useful refusal (a sheet that is
 * nearly right beats "not this channel"). */
function findSheet(sheets: readonly SheetRows[], adapter: MarketplaceAdapter): FileResult<{ sheet: SheetRows; header: HeaderMatch }> {
  let refusal: ImportFileError | null = null;
  for (const sheet of sheets) {
    const header = locateHeader(sheet.rows, adapter.columns!, adapter.label);
    if (header.ok) return { ok: true, value: { sheet, header: header.value } };
    if (refusal === null || refusal.code === "not_this_channel") refusal = header.error;
  }
  return { ok: false, error: refusal! };
}

export function parseMarketplaceFile(input: ParseFileInput): FileResult<ParsedImport> {
  const adapter = adapterFor(input.channelId);
  if (!adapter) return fileError("channel_not_ready", "Kanal ini tidak bisa diimpor.");
  // Refused before a single row is read (plan §2, TikTok).
  if (adapter.columns === null) return fileError("channel_not_ready", adapter.notReadyMessage ?? "Kanal ini belum bisa diimpor.");

  const workbook = readSpreadsheet(input.fileName, input.bytes);
  if (!workbook.ok) return workbook;
  const found = findSheet(workbook.value.sheets, adapter);
  if (!found.ok) return found;
  const { sheet, header } = found.value;

  const grouped = groupOrders({
    rows: sheet.rows,
    headerRowIndex: header.headerRowIndex,
    columns: header.columns,
    specs: adapter.columns,
    date1904: workbook.value.date1904,
  });
  if (!grouped.ok) return grouped;
  const { orders, problems, rowErrors, dataRowCount, blankRowCount, unattributedRowCount } = grouped.value;

  const unknown = new Map<string, { rawStatus: string; orderCount: number }>();
  for (const order of orders) {
    if (Object.hasOwn(adapter.statusMap, order.statusKey)) continue;
    const entry = unknown.get(order.statusKey);
    if (entry) entry.orderCount++;
    else unknown.set(order.statusKey, { rawStatus: order.rawStatus, orderCount: 1 });
  }

  const warnings = header.missingOptional
    .filter((spec) => spec.field === "fee")
    .map((spec) => `Kolom ${spec.label} tidak ada di file; biaya platform pesanan di file ini dihitung belum lengkap.`);
  if (dataRowCount === 0) warnings.push("File tidak berisi baris pesanan.");

  let orderedAtRange: ParsedImport["orderedAtRange"] = null;
  for (const order of orders) {
    if (!orderedAtRange) orderedAtRange = { from: order.orderedAt, to: order.orderedAt };
    else {
      if (order.orderedAt < orderedAtRange.from) orderedAtRange.from = order.orderedAt;
      if (order.orderedAt > orderedAtRange.to) orderedAtRange.to = order.orderedAt;
    }
  }

  const lockedMessage = adapter.mappingVerified ? null : (adapter.lockedMessage ?? "Kanal ini belum bisa disimpan.");
  const saveBlockers = lockedMessage ? [lockedMessage] : [];
  if (unattributedRowCount > 0) {
    saveBlockers.push(
      `${unattributedRowCount.toLocaleString("id-ID")} baris berisi data tapi nomor pesanannya kosong atau tidak valid, jadi tidak jelas milik pesanan mana. Perbaiki atau export ulang file, lalu periksa lagi.`,
    );
  }

  return {
    ok: true,
    value: {
      channelId: adapter.channelId,
      channelLabel: adapter.label,
      mappingVerified: adapter.mappingVerified,
      lockedMessage,
      saveBlockers,
      fileSha256: createHash("sha256").update(input.bytes).digest("hex"),
      format: workbook.value.format,
      sheetName: sheet.name,
      headerRowNumber: header.headerRowIndex + 1,
      dataRowCount,
      blankRowCount,
      unattributedRowCount,
      orders,
      problems,
      rowErrors: rowErrors.slice(0, MAX_LISTED_ROW_ERRORS),
      rowErrorCount: rowErrors.length,
      unknownStatuses: [...unknown.values()],
      warnings,
      orderedAtRange,
    },
  };
}

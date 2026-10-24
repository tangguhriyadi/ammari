import "server-only";
import * as XLSX from "xlsx";
import { fileError, type FileResult } from "./errors";
import { HEADER_SCAN_ROWS, MAX_CELL_CHARS, MAX_COLUMNS, MAX_DATA_ROWS, MAX_FILE_BYTES, MAX_SHEETS } from "./limits";
import { checkXlsxZip } from "./zip-guard";

// File bytes -> rows of plain cell values (docs/plans/marketplace-import.md §10). Only .xlsx and
// .csv are accepted: Seller Center exports .xlsx; .csv covers a re-saved file and TikTok later.
// Legacy .xls (BIFF/OLE) is refused, which also keeps SheetJS's widest parsers (and password
// handling) out of reach. Formulas are never evaluated: only cached values are read.

export type Cell = string | number | boolean | null;

export interface SheetRows {
  name: string;
  rows: Cell[][];
}

export interface ReadWorkbook {
  format: "xlsx" | "csv";
  sheets: SheetRows[];
  /** The workbook counts dates from 1904 (old Mac Excel); date serials need shifting. */
  date1904: boolean;
}

/** Rows read per sheet: the data limit plus room for title rows above the header and the header
 * itself. One more than that means the sheet is too long. */
const ROW_READ_LIMIT = MAX_DATA_ROWS + HEADER_SCAN_ROWS + 1;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const MESSAGES = {
  empty: "File kosong.",
  tooLarge: "File terlalu besar (maks. 10 MB). Export per rentang tanggal yang lebih pendek.",
  unsupported: "Format file tidak didukung. Unggah file .xlsx atau .csv dari Seller Center.",
  ole: "File .xls lama atau file yang dikunci kata sandi belum didukung. Buka di Excel, lalu simpan sebagai .xlsx tanpa kata sandi.",
  unsafe: "File tidak bisa dibaca dengan aman. Export ulang dari Seller Center.",
  unreadable: "File tidak bisa dibaca. Export ulang dari Seller Center.",
  csvEncoding: "File CSV harus berformat UTF-8. Export ulang dari Seller Center.",
  tooManyRows: `Terlalu banyak baris (maks. ${MAX_DATA_ROWS.toLocaleString("id-ID")}). Export per rentang tanggal yang lebih pendek.`,
} as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

function clampCell(cell: Cell): Cell {
  return typeof cell === "string" && cell.length > MAX_CELL_CHARS ? cell.slice(0, MAX_CELL_CHARS) : cell;
}

export function readSpreadsheet(fileName: string, bytes: Uint8Array): FileResult<ReadWorkbook> {
  if (bytes.byteLength === 0) return fileError("empty_file", MESSAGES.empty);
  if (bytes.byteLength > MAX_FILE_BYTES) return fileError("file_too_large", MESSAGES.tooLarge);

  const extension = extensionOf(fileName);
  const isZip = startsWith(bytes, ZIP_MAGIC);
  const isOle = startsWith(bytes, OLE_MAGIC);
  if (isOle && (extension === "xls" || extension === "xlsx")) return fileError("unsupported_type", MESSAGES.ole);
  if (extension === "xlsx" && isZip) return readXlsx(bytes);
  if (extension === "csv" && !isZip && !isOle) return readCsv(bytes);
  return fileError("unsupported_type", MESSAGES.unsupported);
}

function readXlsx(bytes: Uint8Array): FileResult<ReadWorkbook> {
  const guard = checkXlsxZip(bytes);
  if (!guard.ok) return guard.reason === "not_xlsx" ? fileError("unsupported_type", MESSAGES.unsupported) : fileError("unsafe_file", MESSAGES.unsafe);

  let book: XLSX.WorkBook;
  try {
    // The guard's rebuilt, stored-only copy: never the uploaded bytes (zip-guard.ts).
    book = XLSX.read(guard.zip, {
      type: "array",
      dense: true,
      sheetRows: ROW_READ_LIMIT + 1,
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      cellText: false,
      cellDates: false,
      bookVBA: false,
      WTF: false,
    });
  } catch {
    return fileError("unreadable", MESSAGES.unreadable);
  }

  const sheets: SheetRows[] = [];
  for (const name of book.SheetNames.slice(0, MAX_SHEETS)) {
    // Own properties only: a sheet named "toString" or "__proto__" must not resolve to something else.
    if (!Object.hasOwn(book.Sheets, name)) continue;
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const rows = denseRows(sheet);
    if (rows.length > ROW_READ_LIMIT) return fileError("too_many_rows", MESSAGES.tooManyRows);
    sheets.push({ name, rows });
  }
  if (sheets.length === 0) return fileError("unreadable", MESSAGES.unreadable);
  return { ok: true, value: { format: "xlsx", sheets, date1904: book.Workbook?.WBProps?.date1904 === true } };
}

/** A dense SheetJS sheet's `!data` as plain values. `sheetRows` already capped how many rows were
 * read; `!fullref` is set exactly when it cut some off. Error cells (#N/A, #REF!) become the text
 * "#ERROR" so a parser refuses them rather than treating them as blank. */
function denseRows(sheet: XLSX.WorkSheet): Cell[][] {
  const data = (sheet["!data"] ?? []) as (XLSX.CellObject | undefined)[][];
  const rows: Cell[][] = [];
  for (let r = 0; r < data.length; r++) {
    const source = data[r] ?? [];
    const width = Math.min(source.length, MAX_COLUMNS);
    const row: Cell[] = [];
    for (let c = 0; c < width; c++) row.push(clampCell(cellValue(source[c])));
    rows.push(row);
  }
  const fullRef = sheet["!fullref"];
  if (typeof fullRef === "string") {
    const fullRows = XLSX.utils.decode_range(fullRef).e.r + 1;
    // Padding with empty rows only to make the length visible to the caller's limit check.
    while (rows.length < fullRows && rows.length <= ROW_READ_LIMIT) rows.push([]);
  }
  return rows;
}

function cellValue(cell: XLSX.CellObject | undefined): Cell {
  if (!cell) return null;
  switch (cell.t) {
    case "s":
      return typeof cell.v === "string" ? cell.v : String(cell.v ?? "");
    case "n":
      return typeof cell.v === "number" ? cell.v : null;
    case "b":
      return cell.v === true;
    case "e":
      return "#ERROR";
    default:
      return null;
  }
}

function readCsv(bytes: Uint8Array): FileResult<ReadWorkbook> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fileError("unreadable", MESSAGES.csvEncoding);
  }
  if (text.includes("\u0000")) return fileError("unreadable", MESSAGES.unreadable);
  const parsed = parseCsv(text.replace(/^\ufeff/, ""), ROW_READ_LIMIT);
  if (!parsed.ok) return parsed.reason === "too_many_rows" ? fileError("too_many_rows", MESSAGES.tooManyRows) : fileError("unreadable", MESSAGES.unreadable);
  return { ok: true, value: { format: "csv", sheets: [{ name: "CSV", rows: parsed.value }], date1904: false } };
}

const CSV_DELIMITERS = [",", ";", "\t"] as const;

/** Lines looked at to guess the delimiter: the header may sit below title lines. */
const DELIMITER_SCAN_LINES = 10;

/** The delimiter that occurs most often on a single line (outside quotes) among the first lines,
 * which is the header row's; a comma on a tie or when none occurs. */
function detectDelimiter(text: string): string {
  let best = ",";
  let bestCount = 0;
  let counts = new Map<string, number>(CSV_DELIMITERS.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  let lines = 0;
  const endLine = () => {
    for (const delimiter of CSV_DELIMITERS) {
      if (counts.get(delimiter)! > bestCount) {
        bestCount = counts.get(delimiter)!;
        best = delimiter;
      }
    }
    counts = new Map(CSV_DELIMITERS.map((delimiter) => [delimiter, 0]));
    lines++;
  };
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "\n") {
      endLine();
      if (lines >= DELIMITER_SCAN_LINES) return best;
    } else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  endLine();
  return best;
}

/** RFC 4180 CSV: quoted fields may hold delimiters, `""` and newlines; text after a closing quote is
 * malformed. Every value stays text (no number guessing); empty fields are null; a blank line stays
 * as an empty row so row numbers match the file (grouping skips and counts it). An Excel `sep=X`
 * first line sets the delimiter (and is not a row). Cells past MAX_COLUMNS are dropped as they are
 * read. Stops with `too_many_rows` once more than `maxRows` rows were read. */
export function parseCsv(input: string, maxRows: number): { ok: true; value: Cell[][] } | { ok: false; reason: "too_many_rows" | "malformed" } {
  let text = input;
  let delimiter: string;
  const sepLine = /^sep=(.)\r?\n/.exec(text);
  if (sepLine) {
    delimiter = sepLine[1]!;
    text = text.slice(sepLine[0].length);
  } else {
    delimiter = detectDelimiter(text);
  }

  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;
  let fieldWasQuoted = false;
  let afterClosingQuote = false;
  const endField = () => {
    if (row.length < MAX_COLUMNS) row.push(field === "" && !fieldWasQuoted ? null : clampCell(field));
    field = "";
    fieldWasQuoted = false;
    afterClosingQuote = false;
  };
  const endRow = (): boolean => {
    endField();
    rows.push(row.every((cell) => cell === null) ? [] : row);
    row = [];
    return rows.length <= maxRows;
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          afterClosingQuote = true;
        }
      } else {
        field += char;
      }
    } else if (afterClosingQuote && char !== delimiter && char !== "\n" && char !== "\r") {
      return { ok: false, reason: "malformed" };
    } else if (char === '"' && field === "") {
      quoted = true;
      fieldWasQuoted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      if (!endRow()) return { ok: false, reason: "too_many_rows" };
    } else {
      field += char;
    }
  }
  if (quoted) return { ok: false, reason: "malformed" };
  if (field !== "" || fieldWasQuoted || row.length > 0) {
    if (!endRow()) return { ok: false, reason: "too_many_rows" };
  }
  return { ok: true, value: rows };
}

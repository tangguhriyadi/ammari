// Spreadsheet text exports (CSV download, tab-separated copy). Plain module: the copy buttons build
// their text on the client from the same functions.
//
// Formula injection: a spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` (and some
// treat a leading tab or CR the same way) as a formula, so every TEXT cell starting with one gets
// a leading apostrophe, which the spreadsheet shows as plain text. Numbers are written as numbers.

export type SpreadsheetCell = string | number | null;

const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function csvField(cell: SpreadsheetCell): string {
  if (cell === null) return "";
  if (typeof cell === "number") return String(cell);
  const text = neutralizeFormula(cell);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV, comma-separated, CRLF line ends, with a UTF-8 BOM (Excel otherwise reads UTF-8
 * as a legacy code page). */
export function buildCsv(rows: readonly (readonly SpreadsheetCell[])[]): string {
  return `\ufeff${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** Tab-separated text for the clipboard: Google Sheets and Excel paste it as columns whatever
 * the locale's list separator is. Tabs and line breaks inside a cell become spaces. */
export function buildTsv(rows: readonly (readonly SpreadsheetCell[])[]): string {
  const field = (cell: SpreadsheetCell) => (cell === null ? "" : typeof cell === "number" ? String(cell) : neutralizeFormula(cell.replace(/\r\n|[\t\r\n]/g, " ")));
  return rows.map((row) => row.map(field).join("\t")).join("\n") + "\n";
}

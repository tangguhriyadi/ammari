import type { Cell } from "./read-sheet";

// Strict cell parsers for the marketplace import (docs/plans/marketplace-import.md §2.2). Every
// one either returns a value or says why not: never a guess, never parseFloat, never a silent 0.
// A blank cell is `null` (the caller decides whether blank is allowed), not an error.

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (message: string): ParseResult<never> => ({ ok: false, message });

function isBlank(cell: Cell): boolean {
  return cell === null || (typeof cell === "string" && cell.trim() === "");
}

/** Whole rupiah >= 0. Numeric cells must already be whole; text accepts "Rp", spaces, "." as the
 * thousands separator (in proper groups of 3) and an optional ",0" / ",00". "-" alone (Seller
 * Center's "nothing here") is blank. Negatives are refused until a real export shows what a
 * negative fee means (plan §2.2). */
export function parseMoney(cell: Cell): ParseResult<number | null> {
  if (isBlank(cell)) return ok(null);
  if (typeof cell === "number") {
    if (!Number.isSafeInteger(cell)) return fail("Angka uang harus bilangan bulat rupiah.");
    if (cell < 0) return fail("Angka uang tidak boleh negatif.");
    return ok(cell);
  }
  if (typeof cell !== "string") return fail("Angka uang tidak valid.");
  const text = cell.replace(/[\s\u00a0]+/g, "").replace(/^rp/i, "");
  if (text === "-") return ok(null);
  const match = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,0{1,2})?$/.exec(text);
  if (!match) return fail(`"${shorten(cell)}" bukan angka rupiah yang valid.`);
  const value = Number(match[1]!.replaceAll(".", ""));
  if (!Number.isSafeInteger(value)) return fail("Angka uang terlalu besar.");
  return ok(value);
}

export const MAX_LINE_QTY = 1000;

/** Whole pieces, 1 to MAX_LINE_QTY. Never blank. */
export function parseQty(cell: Cell): ParseResult<number> {
  let value: number;
  if (typeof cell === "number") value = cell;
  else if (typeof cell === "string" && /^\s*\d+\s*$/.test(cell)) value = Number(cell.trim());
  else return fail("Jumlah harus bilangan bulat.");
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LINE_QTY) return fail(`Jumlah harus antara 1 dan ${MAX_LINE_QTY}.`);
  return ok(value);
}

const ORDER_NO_PATTERN = /^[A-Z0-9]{6,32}$/;

/** Excel keeps 15 significant digits; a longer number in a number cell has already lost digits. */
const MAX_EXACT_EXCEL_INTEGER = 999_999_999_999_999;

/** The marketplace's order number, trimmed and uppercased. Letters and digits only, 6 to 32 long,
 * which also keeps any formula-looking text ("=HYPERLINK(...)") out of the database. A number
 * cell is accepted only up to 15 digits: a longer id stored as a number has already been rounded
 * (its last digits zeroed), and two orders could collapse into one. */
export function parseChannelOrderNo(cell: Cell): ParseResult<string> {
  let text: string;
  if (typeof cell === "number") {
    if (!Number.isSafeInteger(cell) || cell < 0 || cell > MAX_EXACT_EXCEL_INTEGER) return fail("Nomor pesanan terbaca sebagai angka dan bisa terpotong. Export ulang filenya.");
    text = String(cell);
  } else if (typeof cell === "string") {
    text = cell.trim().toUpperCase();
  } else {
    return fail("Nomor pesanan kosong atau tidak valid.");
  }
  if (!ORDER_NO_PATTERN.test(text)) return fail(text === "" ? "Nomor pesanan kosong." : "Nomor pesanan hanya boleh huruf dan angka (6 sampai 32 karakter).");
  return ok(text);
}

export const MAX_SKU_LENGTH = 64;

/** The marketplace's variant SKU, trimmed and uppercased (admin SKUs are generated uppercase,
 * `generateSku`). Nothing else is rewritten: a SKU that only matches after more cleanup is a
 * different SKU, and the owner fixes it on the marketplace (or matches it by hand, plan §8.1).
 * Blank is `null`, reported later as an unknown SKU. */
export function parseSku(cell: Cell): ParseResult<string | null> {
  if (isBlank(cell)) return ok(null);
  if (typeof cell !== "string" && typeof cell !== "number") return fail("SKU tidak valid.");
  const text = String(cell).trim().toUpperCase();
  if (text.length > MAX_SKU_LENGTH) return fail(`SKU lebih dari ${MAX_SKU_LENGTH} karakter.`);
  // Control characters (tab, newline, NUL...) are never part of a SKU.
  if (/[\u0000-\u001f\u007f]/.test(text)) return fail("SKU berisi karakter yang tidak valid.");
  return ok(text);
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const MS_PER_DAY = 86_400_000;
/** Excel serial of 1970-01-01 in the 1900 date system; 1904-system serials are 1462 days less. */
const EXCEL_UNIX_EPOCH_SERIAL = 25_569;
const EXCEL_1904_OFFSET_DAYS = 1_462;
/** Serials outside 2000-01-01 .. 2100-01-01 are not order dates (a stray number, a qty). */
const MIN_SERIAL = 36_526;
const MAX_SERIAL = 73_051;

/** A Seller Center time, as Asia/Jakarta wall time (fixed UTC+7, no DST), to its UTC instant.
 * Text must be `YYYY-MM-DD HH:mm[:ss]`; day-first or month-first text is refused rather than
 * guessed (both exist in the wild). Numbers are Excel date serials. */
export function parseJakartaDateTime(cell: Cell, date1904: boolean): ParseResult<Date> {
  if (typeof cell === "number") {
    const serial = date1904 ? cell + EXCEL_1904_OFFSET_DAYS : cell;
    if (!Number.isFinite(serial) || serial < MIN_SERIAL || serial > MAX_SERIAL) return fail("Waktu pesanan tidak valid.");
    // To the nearest second: serials carry float noise (14:05 is not exact in binary).
    const wallMs = Math.round(((serial - EXCEL_UNIX_EPOCH_SERIAL) * MS_PER_DAY) / 1000) * 1000;
    return ok(new Date(wallMs - JAKARTA_OFFSET_MS));
  }
  if (typeof cell !== "string") return fail("Waktu pesanan kosong atau tidak valid.");
  const match = DATE_TIME_PATTERN.exec(cell.trim());
  if (!match) return fail(`"${shorten(cell)}" bukan waktu dengan format TTTT-BB-HH JJ:MM.`);
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part))) as [number, number, number, number, number, number];
  if (hour > 23 || minute > 59 || second > 59) return fail("Waktu pesanan tidak valid.");
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wallMs);
  // Date.UTC rolls 30 February over into March; a real calendar date survives the round trip.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return fail("Tanggal pesanan tidak ada di kalender.");
  return ok(new Date(wallMs - JAKARTA_OFFSET_MS));
}

function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
}

// ---------- Text-only parsers (the real Shopee export, plan §19.1) ----------
// Every cell of the 27 Nov 2026 "Pesanan Saya" export is TEXT: rupiah with "." thousands and no
// decimals, times "YYYY-MM-DD HH:MM" in Jakarta, "" for empty. Anything else (a number cell, a
// decimal, a comma, seconds) means the file is not the shape that was verified, so it is a row
// error, never a guess. `label` names the column in the message.

const notText = (label: string) => fail(`${label} harus berupa teks seperti di export Shopee.`);

/** One money cell's ceiling: Rp 10 miliar, far above any real gamis row. With at most MAX_LINE_QTY
 * pieces per row and MAX_DATA_ROWS rows, every sum of a file stays a safe integer (exact). */
export const MAX_RUPIAH_CELL = 10_000_000_000;

/** Whole rupiah >= 0 written "229.000", "8.000" or "0": digits in proper groups of 3 joined by ".",
 * no leading zero, nothing else, at most MAX_RUPIAH_CELL. Blank ("") is `null`. */
export function parseRupiahText(cell: Cell, label: string): ParseResult<number | null> {
  if (isBlank(cell)) return ok(null);
  if (typeof cell !== "string") return notText(label);
  const text = cell.trim();
  if (!/^(?:0|[1-9]\d{0,2}(?:\.\d{3})*)$/.test(text)) return fail(`"${shorten(cell)}" bukan angka rupiah dengan format 229.000.`);
  const value = Number(text.replaceAll(".", ""));
  if (!Number.isSafeInteger(value) || value > MAX_RUPIAH_CELL) return fail("Angka uang terlalu besar.");
  return ok(value);
}

/** The variant SKU as text only: a number cell may already have lost leading zeros ("00123" -> 123)
 * and could match the wrong variant. Otherwise as `parseSku`. */
export function parseSkuText(cell: Cell): ParseResult<string | null> {
  if (typeof cell === "number") return notText("Nomor Referensi SKU");
  return parseSku(cell);
}

/** A whole count >= 0 as text ("0", "2"), up to MAX_LINE_QTY. Blank is `null`. */
export function parseCountText(cell: Cell, label: string): ParseResult<number | null> {
  if (isBlank(cell)) return ok(null);
  if (typeof cell !== "string") return notText(label);
  const text = cell.trim();
  const value = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value > MAX_LINE_QTY) return fail(`${label} harus bilangan bulat 0 atau lebih.`);
  return ok(value);
}

/** Jumlah as text, 1 to MAX_LINE_QTY. Never blank. */
export function parseQtyText(cell: Cell): ParseResult<number> {
  if (typeof cell === "number") return notText("Jumlah");
  return parseQty(cell);
}

const MINUTE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** "YYYY-MM-DD HH:MM", Asia/Jakarta, to its UTC instant. No seconds, no serials, no other shapes. */
export function parseJakartaMinuteText(cell: Cell, label: string): ParseResult<Date> {
  if (typeof cell === "number") return notText(label);
  if (typeof cell !== "string") return fail(`${label} kosong atau tidak valid.`);
  if (!MINUTE_TIME_PATTERN.test(cell.trim())) return fail(`"${shorten(cell)}" bukan waktu dengan format TTTT-BB-HH JJ:MM.`);
  return parseJakartaDateTime(cell, false);
}

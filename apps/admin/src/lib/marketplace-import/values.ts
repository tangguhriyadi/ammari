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

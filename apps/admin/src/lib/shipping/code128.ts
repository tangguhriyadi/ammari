// Code 128 barcode encoder for the shipping label (docs/plans/cart-checkout.md §15 Phase K,
// decision 49: our own 120 x 100 mm label, no barcode package). Pure: text in, bar/space widths
// out; ./label-pdf.ts draws them. Per ISO/IEC 15417:
// - every symbol is 3 bars and 3 spaces, 11 modules wide (the stop symbol: 4 bars, 3 spaces, 13);
// - code set B carries ASCII 32 to 126 (value = char code - 32), code set C carries digit pairs
//   00 to 99 (value = the pair), so long digit runs take half the width;
// - start symbols B = 104, C = 105; "Code C" = 99 inside set B, "Code B" = 100 inside set C;
// - check symbol = (start value + sum of value x position) mod 103, positions from 1;
// - a quiet zone of at least 10 modules on both sides (drawn by the label, not encoded here).
// Courier waybills are digits or upper-case letters and digits, so set A (control characters) and
// FNC codes are never needed: text outside ASCII 32 to 126 is refused.

/** Bar/space widths in modules for symbol values 0 to 106 (106 = stop, 7 elements). */
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE128_START_B = 104;
export const CODE128_START_C = 105;
export const CODE128_CODE_C = 99;
export const CODE128_CODE_B = 100;
export const CODE128_STOP = 106;
/** ISO/IEC 15417 minimum quiet zone on each side, in modules. */
export const CODE128_QUIET_ZONE_MODULES = 10;

export interface Code128 {
  /** Symbol values in order: start, data (with set switches), check, stop. */
  values: number[];
  /** Alternating bar, space, bar, ... widths in modules, starting and ending with a bar. */
  widths: number[];
  /** Total width in modules, quiet zones excluded. */
  modules: number;
}

function isDigit(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

function digitRun(text: string, from: number): number {
  let end = from;
  while (end < text.length && isDigit(text, end)) end += 1;
  return end - from;
}

/** Whether a digit run at `index` is worth set C: at the very start 4 or more digits (2 when they
 * are the whole text), elsewhere 6 or more (4 when they end the text), the usual rule that never
 * makes the code longer than staying in set B. */
function worthSetC(text: string, index: number, atStart: boolean): boolean {
  const run = digitRun(text, index);
  const reachesEnd = index + run === text.length;
  if (atStart) return run >= (reachesEnd ? 2 : 4);
  return run >= (reachesEnd ? 4 : 6);
}

/** Encodes `text` (1 to 80 characters of ASCII 32 to 126). Throws a RangeError otherwise. */
export function encodeCode128(text: string): Code128 {
  if (text.length === 0 || text.length > 80) throw new RangeError("Code 128 text must be 1 to 80 characters");
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) throw new RangeError("Code 128 text must be printable ASCII");
  }

  const values: number[] = [];
  let set: "B" | "C";
  let index = 0;
  if (worthSetC(text, 0, true)) {
    set = "C";
    values.push(CODE128_START_C);
  } else {
    set = "B";
    values.push(CODE128_START_B);
  }

  while (index < text.length) {
    if (set === "C") {
      if (digitRun(text, index) >= 2) {
        values.push(Number(text.slice(index, index + 2)));
        index += 2;
      } else {
        values.push(CODE128_CODE_B);
        set = "B";
      }
      continue;
    }
    if (worthSetC(text, index, false)) {
      // An odd run: its first digit stays in set B, the rest pair up in set C.
      if (digitRun(text, index) % 2 === 1) {
        values.push(text.charCodeAt(index) - 32);
        index += 1;
      }
      values.push(CODE128_CODE_C);
      set = "C";
      continue;
    }
    values.push(text.charCodeAt(index) - 32);
    index += 1;
  }

  let sum = values[0]!;
  for (let position = 1; position < values.length; position += 1) sum += values[position]! * position;
  values.push(sum % 103, CODE128_STOP);

  const widths = values.flatMap((value) => [...CODE128_PATTERNS[value]!].map(Number));
  return { values, widths, modules: widths.reduce((total, width) => total + width, 0) };
}

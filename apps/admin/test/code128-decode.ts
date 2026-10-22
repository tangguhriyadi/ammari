import { CODE128_CODE_B, CODE128_CODE_C, CODE128_PATTERNS, CODE128_START_B, CODE128_START_C, CODE128_STOP } from "@/lib/shipping/code128";

/** Test-only, independent of the encoder: reads Code 128 bar/space widths (in modules) back to text
 * the way a scanner does: 6 elements per symbol (7 for the stop), pattern lookup, check symbol,
 * then the set B / set C meaning of each value. Throws on anything a scanner would reject. */
export function decodeCode128(widths: number[]): { text: string; values: number[] } {
  const lookup = new Map(CODE128_PATTERNS.map((pattern, value) => [pattern, value]));
  const values: number[] = [];
  let offset = 0;
  while (offset < widths.length) {
    const remaining = widths.length - offset;
    const take = remaining === 7 ? 7 : 6;
    const value = lookup.get(widths.slice(offset, offset + take).join(""));
    if (value === undefined) throw new Error(`no symbol at element ${offset}`);
    values.push(value);
    offset += take;
  }
  if (values.at(-1) !== CODE128_STOP) throw new Error("no stop symbol");
  const data = values.slice(0, -2);
  const check = values.at(-2)!;
  const sum = data.reduce((total, value, position) => total + (position === 0 ? value : value * position), 0);
  if (sum % 103 !== check) throw new Error("check symbol mismatch");

  if (data[0] !== CODE128_START_B && data[0] !== CODE128_START_C) throw new Error("no start B or start C symbol");
  let set: "B" | "C" = data[0] === CODE128_START_C ? "C" : "B";
  let text = "";
  for (const value of data.slice(1)) {
    if (set === "B" && value === CODE128_CODE_C) set = "C";
    else if (set === "C" && value === CODE128_CODE_B) set = "B";
    else if (set === "B") text += String.fromCharCode(value + 32);
    else text += String(value).padStart(2, "0");
  }
  return { text, values };
}

/** Run lengths of one scanline (true = black), from the first black pixel to the last, as Code 128
 * element widths: each run divided by `moduleDots`, which must come out whole (a printer that hits
 * the dot grid prints every module the same width). */
export function scanlineToWidths(scanline: boolean[], moduleDots: number): number[] {
  const first = scanline.indexOf(true);
  const last = scanline.lastIndexOf(true);
  if (first < 0) throw new Error("no bars on the scanline");
  const widths: number[] = [];
  let run = 1;
  for (let index = first + 1; index <= last + 1; index += 1) {
    if (index <= last && scanline[index] === scanline[index - 1]) {
      run += 1;
      continue;
    }
    if (run % moduleDots !== 0) throw new Error(`run of ${run} dots at ${index - run} is not a whole number of ${moduleDots}-dot modules`);
    widths.push(run / moduleDots);
    run = 1;
  }
  return widths;
}

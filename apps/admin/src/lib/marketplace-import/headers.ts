import { columnSpecId, type ColumnSpec } from "./adapters/types";
import { fileError, type FileResult } from "./errors";
import { HEADER_SCAN_ROWS } from "./limits";
import type { Cell } from "./read-sheet";

// Header row detection and column mapping (docs/plans/marketplace-import.md §2). Columns are found
// by their header text, never by position: Seller Center adds and reorders columns between
// versions. Anything ambiguous is refused, never guessed.

/** NFKC (full-width -> ASCII), lowercase, whitespace runs to one space, trimmed, a trailing "(Rp)" /
 * "(IDR)" unit dropped. Also used for status texts. */
export function normalizeHeader(cell: Cell): string | null {
  if (typeof cell !== "string") return null;
  const text = cell
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\((rp|idr)\)$/, "");
  return text === "" ? null : text;
}

export interface HeaderMatch {
  headerRowIndex: number;
  /** Spec id (`columnSpecId`) -> column index. */
  columns: Map<string, number>;
  missingOptional: ColumnSpec[];
}

function aliasIndex(specs: readonly ColumnSpec[]): Map<string, ColumnSpec> {
  const index = new Map<string, ColumnSpec>();
  for (const spec of specs) for (const alias of spec.aliases) index.set(normalizeHeader(alias)!, spec);
  return index;
}

export function locateHeader(rows: readonly Cell[][], specs: readonly ColumnSpec[], channelLabel: string): FileResult<HeaderMatch> {
  const byAlias = aliasIndex(specs);
  const required = specs.filter((spec) => spec.required);

  let bestRow = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const found = new Set<string>();
    for (const cell of rows[r] ?? []) {
      const spec = byAlias.get(normalizeHeader(cell) ?? "");
      if (spec?.required) found.add(columnSpecId(spec));
    }
    if (found.size > bestScore) {
      bestScore = found.size;
      bestRow = r;
    }
  }
  if (bestRow === -1) {
    return fileError("not_this_channel", `File ini bukan export Pesanan ${channelLabel}: judul kolomnya tidak dikenali. Pastikan memilih kanal dan file yang benar.`);
  }

  const columns = new Map<string, number>();
  const duplicated = new Set<string>();
  (rows[bestRow] ?? []).forEach((cell, columnIndex) => {
    const spec = byAlias.get(normalizeHeader(cell) ?? "");
    if (!spec) return;
    const id = columnSpecId(spec);
    if (columns.has(id)) duplicated.add(spec.label);
    else columns.set(id, columnIndex);
  });
  if (duplicated.size > 0) {
    return fileError("ambiguous_columns", `Kolom ${[...duplicated].join(", ")} muncul lebih dari sekali, jadi file tidak bisa dibaca dengan pasti. Export ulang dari Seller Center.`);
  }

  const missing = required.filter((spec) => !columns.has(columnSpecId(spec)));
  if (missing.length > 0) {
    return fileError(
      "missing_columns",
      `Kolom wajib tidak ditemukan: ${missing.map((spec) => spec.label).join(", ")}. Pastikan file adalah export Pesanan dari ${channelLabel} Seller Center.`,
    );
  }

  return {
    ok: true,
    value: { headerRowIndex: bestRow, columns, missingOptional: specs.filter((spec) => !spec.required && !columns.has(columnSpecId(spec))) },
  };
}

// Upload limits for the marketplace import (owner decision 15, docs/plans/marketplace-import.md
// §10). One place, so the reader, the grouping and the UI copy always agree.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_DATA_ROWS = 20_000;
export const MAX_ORDERS = 5_000;

/** Header row search depth: Seller Center exports may put title rows above the header. */
export const HEADER_SCAN_ROWS = 10;
/** Longer cells are cut before any parser sees them (no legitimate field comes close). */
export const MAX_CELL_CHARS = 1_000;
/** Cells after this column are ignored (Shopee exports have about 60 columns). */
export const MAX_COLUMNS = 500;
/** Only this many sheets are looked at; an order export has one. */
export const MAX_SHEETS = 20;

// xlsx (zip) guard (zip-guard.ts). A real order export is a handful of entries and a few MB of
// XML; these leave room for a 20.000-row export while bounding what a crafted file can cost.
export const MAX_ZIP_ENTRIES = 100;
export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;

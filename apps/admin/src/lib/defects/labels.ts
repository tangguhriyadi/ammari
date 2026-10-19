import type { DefectDisposalType, DefectItemKind, DefectMovementType } from "@ammari/db/schema";

// Indonesian display labels for the defect ledger (docs/plans/suppliers-goods-receipt.md §3.5).
// UI copy only, never stored, so wording changes need no migration. Client-safe (no server
// imports).

export const DEFECT_MOVEMENT_TYPE_LABELS: Record<DefectMovementType, string> = {
  reject: "Ditolak saat diterima",
  return_out: "Dikembalikan untuk ditukar",
  dispose: "Dilepas",
  reversal: "Pembatalan",
};

/** D24 + D29. Hibah and Dibuang/Dimusnahkan are both Rp 0 but always shown separately: a donation
 * is a deliberate giveaway, discarding is waste. */
export const DEFECT_DISPOSAL_TYPE_LABELS: Record<DefectDisposalType, string> = {
  auction: "Lelang",
  donation: "Hibah",
  discarded: "Dibuang/Dimusnahkan",
};

export const DEFECT_ITEM_KIND_LABELS: Record<DefectItemKind, string> = {
  sku: "Barang jadi",
  fabric: "Kain",
  accessory: "Aksesoris",
};

import { SUPPLIER_KINDS, type SupplierKind } from "@ammari/db/schema";

export { SUPPLIER_KINDS, type SupplierKind };

/** Indonesian display labels for each supplier kind — NOT stored in the DB (only the key is,
 * see suppliers.kinds' own CHECK constraints), so wording can change without a migration. Same
 * key↔label split packages/db/src/catalog/highlights.ts already uses; this module lives in
 * apps/admin rather than @ammari/db because nothing on the storefront ever renders a supplier.
 *
 * No "server-only" import here on purpose: the supplier form is a Client Component and reads
 * these labels directly (lib/suppliers/queries.ts, which does touch the database, is the
 * server-only half). */
export const SUPPLIER_KIND_LABELS: Record<SupplierKind, string> = {
  fabric: "Kain",
  accessory: "Aksesoris",
  service: "Jasa (penjahit)",
  other: "Lainnya",
};

/** `SUPPLIER_KINDS` paired with its own label, in the one canonical order — the convenient
 * shape for rendering the fixed checkbox list without every call site re-zipping the two
 * together (same helper PRODUCT_HIGHLIGHTS provides for highlights). */
export const SUPPLIER_KIND_OPTIONS: readonly { key: SupplierKind; label: string }[] = SUPPLIER_KINDS.map((key) => ({
  key,
  label: SUPPLIER_KIND_LABELS[key],
}));

/** Read-only label list for a stored `kinds` array, in SUPPLIER_KINDS' canonical order — never
 * the row's own storage order, same rule product-list.tsx's `highlightLabels` follows. */
export function supplierKindLabels(kinds: readonly string[]): string[] {
  return SUPPLIER_KIND_OPTIONS.filter((option) => kinds.includes(option.key)).map((option) => option.label);
}

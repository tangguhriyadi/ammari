import { PRODUCT_HIGHLIGHT_KEYS, type ProductHighlightKey } from "../schema/constants";

export { PRODUCT_HIGHLIGHT_KEYS, type ProductHighlightKey };

/** Indonesian display labels for each key — NOT stored in the DB (only the key is, see
 * products.highlights' own CHECK constraints), so wording can change without a migration. The
 * future storefront pairs each key with its own icon; this module is the single source both
 * apps/admin and (later) apps/web read the key↔label mapping from. */
export const PRODUCT_HIGHLIGHT_LABELS: Record<ProductHighlightKey, string> = {
  breathable: "Breathable",
  flowy: "Flowy",
  falls_perfectly: "Jatuh sempurna",
  cool_fabric: "Bahan sejuk",
  not_see_through: "Tidak menerawang",
};

/** `PRODUCT_HIGHLIGHT_KEYS` paired with its own label, in the one canonical order — the
 * convenient shape for rendering a fixed checkbox list or a fixed set of read-only badges
 * without every call site re-zipping the two arrays together itself. */
export const PRODUCT_HIGHLIGHTS: readonly { key: ProductHighlightKey; label: string }[] = PRODUCT_HIGHLIGHT_KEYS.map(
  (key) => ({ key, label: PRODUCT_HIGHLIGHT_LABELS[key] }),
);

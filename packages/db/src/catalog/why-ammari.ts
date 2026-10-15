import { WHY_AMMARI_ICON_KEYS, type WhyAmmariIconKey } from "../schema/constants";

export { WHY_AMMARI_ICON_KEYS, type WhyAmmariIconKey };

/** Indonesian display labels for each key — NOT stored in the DB (the "why_ammari" JSONB content
 * only stores the key, see schema/constants.ts's doc comment on WHY_AMMARI_ICON_KEYS), so wording
 * can change without a migration. apps/admin (the icon picker) and apps/web (the rendered
 * section) both read the key↔label mapping from this one module — same split
 * packages/db/src/catalog/highlights.ts already uses for PRODUCT_HIGHLIGHT_KEYS. */
export const WHY_AMMARI_ICON_LABELS: Record<WhyAmmariIconKey, string> = {
  syari_design: "Desain Syar'i",
  premium_fabric: "Bahan Premium",
  handmade_craftsmanship: "Dijahit dengan Teliti",
  comfortable_fit: "Nyaman Seharian",
  easy_care: "Mudah Dirawat",
  responsive_service: "Respon Cepat",
  trusted_by_customers: "Dipercaya Ribuan Pelanggan",
  bandung_made: "Dibuat di Bandung",
};

/** `WHY_AMMARI_ICON_KEYS` paired with its own label, in the one canonical order — the convenient
 * shape for rendering a fixed icon-picker grid without the call site re-zipping the two arrays
 * together itself. */
export const WHY_AMMARI_ICONS: readonly { key: WhyAmmariIconKey; label: string }[] = WHY_AMMARI_ICON_KEYS.map(
  (key) => ({ key, label: WHY_AMMARI_ICON_LABELS[key] }),
);

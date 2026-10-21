/** Shipping address input for web checkout and saved addresses (plan §4.3, §4.5.1, D12).
 *
 * Version 2 (session 8, 2026-10-21): the area (kecamatan, city, province, kode pos) is no longer
 * typed. The buyer picks a shipping-provider area (Biteship Maps) from a search, the server loads
 * that `shipping_areas` row by our own id, and `parseShippingAddress` takes the free fields plus that
 * loaded row. Biteship areas stop at kecamatan + kode pos, so the kelurahan is typed in the street
 * address (owner decision 2026-10-21) and `subdistrict` stays null. Version 1 (session 3, typed
 * province/city/kecamatan/kode pos) never reached an order.
 *
 * Pure functions with no database or server-only imports, so the checkout form can run the same
 * checks in the browser that the server action runs again before writing. */

/** The 38 provinces (Kepmendagri 2025), alphabetical. No longer used by the checkout form (the area
 * comes from the provider search since v2); kept for admin manual orders (plan §4.5.1). Province
 * names are stored as text, never matched as reference data by the database. */
export const INDONESIAN_PROVINCES = [
  "Aceh",
  "Bali",
  "Banten",
  "Bengkulu",
  "DI Yogyakarta",
  "DKI Jakarta",
  "Gorontalo",
  "Jambi",
  "Jawa Barat",
  "Jawa Tengah",
  "Jawa Timur",
  "Kalimantan Barat",
  "Kalimantan Selatan",
  "Kalimantan Tengah",
  "Kalimantan Timur",
  "Kalimantan Utara",
  "Kepulauan Bangka Belitung",
  "Kepulauan Riau",
  "Lampung",
  "Maluku",
  "Maluku Utara",
  "Nusa Tenggara Barat",
  "Nusa Tenggara Timur",
  "Papua",
  "Papua Barat",
  "Papua Barat Daya",
  "Papua Pegunungan",
  "Papua Selatan",
  "Papua Tengah",
  "Riau",
  "Sulawesi Barat",
  "Sulawesi Selatan",
  "Sulawesi Tengah",
  "Sulawesi Tenggara",
  "Sulawesi Utara",
  "Sumatera Barat",
  "Sumatera Selatan",
  "Sumatera Utara",
] as const;

export type IndonesianProvince = (typeof INDONESIAN_PROVINCES)[number];

/** The picked `shipping_areas` row, as the server loaded it by `shippingAreaId` (never fields the
 * browser sent). */
export interface ShippingAddressArea {
  id: string;
  province: string;
  city: string;
  district: string;
  subdistrict: string | null;
  postalCode: string | null;
  /** The provider's area id; an area without one cannot be quoted, so it counts as not picked. */
  providerAreaId: string | null;
}

export interface ShippingAddress {
  recipientName: string;
  /** `+62...`, matching the `+62[0-9]{8,13}` CHECK on customers, orders and customer_addresses. */
  phone: string;
  /** Street, house number, RT/RW and kelurahan. */
  addressLine: string;
  notes: string | null;
  /** `shipping_areas.id`. */
  shippingAreaId: string;
  providerAreaId: string;
  province: string;
  city: string;
  district: string;
  subdistrict: string | null;
  /** The area's kode pos, or the one the buyer typed when the area has none. */
  postalCode: string;
}

/** Stored in `orders.shipping_address_snapshot`. `version` tells this shape apart from any later
 * one. */
export interface ShippingAddressSnapshot extends ShippingAddress {
  version: 2;
}

/** The form fields, in form order. */
export type ShippingAddressField = "recipientName" | "phone" | "shippingAreaId" | "postalCode" | "addressLine" | "notes";

export interface ShippingAddressError {
  field: ShippingAddressField;
  message: string;
}

export type ParseShippingAddressResult =
  | { ok: true; value: ShippingAddress }
  | { ok: false; errors: ShippingAddressError[] };

/** Normalizes an Indonesian mobile number as typed (`0812-3456-7890`, `+62 812...`, `62812...`,
 * `812...`) to `+62` followed by the national number without its leading 0. Returns null for
 * anything that is not a mobile number (national part `8` plus 7 to 12 digits, so 8 to 13 digits
 * in all, inside the DB CHECK `+62[0-9]{8,13}`). Landlines are refused: the contact number is a
 * WhatsApp number and the recipient number must reach the courier's call or WhatsApp. */
export function normalizeIndonesianPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  if (!/^\+?[0-9]+$/.test(compact)) return null;

  let national: string;
  if (compact.startsWith("+")) {
    if (!compact.startsWith("+62")) return null;
    national = compact.slice(3);
  } else if (compact.startsWith("62")) {
    national = compact.slice(2);
  } else if (compact.startsWith("0")) {
    national = compact.slice(1);
  } else if (compact.startsWith("8")) {
    national = compact;
  } else {
    return null;
  }

  return /^8[0-9]{7,12}$/.test(national) ? `+62${national}` : null;
}

/** Control characters become spaces, then whitespace runs (including newlines) collapse to one
 * space: every field is stored and printed as a single line. Invisible format characters
 * (zero-width spaces, direction marks) are dropped so a field cannot pass the length checks while
 * rendering blank, and lone UTF-16 surrogates (broken pasted emoji) are dropped because Postgres
 * rejects them inside jsonb (22P05), which would fail the checkout after validation passed. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\p{Cf}/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LIMITS = {
  recipientName: { min: 2, max: 100 },
  addressLine: { min: 5, max: 500 },
  notes: { max: 200 },
} as const;

/** Same rule as the DB CHECK `[0-9]{5}`, stricter: no Indonesian postal code starts with 0. */
const POSTAL_CODE = /^[1-9][0-9]{4}$/;

/** Validates and normalizes raw form input against the picked area row (`null` when the form sent
 * no area id or one that is not in `shipping_areas`). Collects every problem (in form order) so
 * checkout can show one alert listing everything to fix. Never throws on malformed input. The
 * typed kode pos is read only when the area has none. */
export function parseShippingAddress(input: unknown, area: ShippingAddressArea | null): ParseShippingAddressResult {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const errors: ShippingAddressError[] = [];

  function requiredText(field: "recipientName" | "addressLine", label: string): string {
    const value = cleanText(raw[field]) ?? "";
    const { min, max } = LIMITS[field];
    if (value.length === 0) errors.push({ field, message: `${label} wajib diisi.` });
    else if (value.length < min) errors.push({ field, message: `${label} terlalu pendek.` });
    else if (value.length > max) errors.push({ field, message: `${label} maksimal ${max} karakter.` });
    return value;
  }

  const recipientName = requiredText("recipientName", "Nama penerima");

  const phoneRaw = cleanText(raw.phone) ?? "";
  const phone = phoneRaw.length > 0 ? normalizeIndonesianPhone(phoneRaw) : null;
  if (phoneRaw.length === 0) errors.push({ field: "phone", message: "Nomor HP penerima wajib diisi." });
  else if (phone === null) {
    errors.push({ field: "phone", message: "Nomor HP penerima tidak valid. Contoh: 0812 3456 7890." });
  }

  const pickedArea = area && area.providerAreaId ? area : null;
  if (!pickedArea) errors.push({ field: "shippingAreaId", message: "Pilih kecamatan dari daftar." });

  let postalCode = "";
  if (pickedArea && pickedArea.postalCode && POSTAL_CODE.test(pickedArea.postalCode)) {
    postalCode = pickedArea.postalCode;
  } else if (pickedArea) {
    // Spaces inside are dropped ("401 32").
    postalCode = (cleanText(raw.postalCode) ?? "").replace(/\s/g, "");
    if (postalCode.length === 0) errors.push({ field: "postalCode", message: "Kode pos wajib diisi." });
    else if (!POSTAL_CODE.test(postalCode)) errors.push({ field: "postalCode", message: "Kode pos harus 5 angka." });
  }

  const addressLine = requiredText("addressLine", "Alamat lengkap");

  const notesValue = cleanText(raw.notes) ?? "";
  if (notesValue.length > LIMITS.notes.max) {
    errors.push({ field: "notes", message: `Catatan untuk kurir maksimal ${LIMITS.notes.max} karakter.` });
  }

  if (errors.length > 0 || phone === null || !pickedArea || !pickedArea.providerAreaId) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      recipientName,
      phone,
      addressLine,
      notes: notesValue.length > 0 ? notesValue : null,
      shippingAreaId: pickedArea.id,
      providerAreaId: pickedArea.providerAreaId,
      province: pickedArea.province,
      city: pickedArea.city,
      district: pickedArea.district,
      subdistrict: pickedArea.subdistrict,
      postalCode,
    },
  };
}

/** The single-line text written to `orders.shipping_address`, so admin order detail and packing
 * (which show that column as one line) keep working for web orders. The kelurahan, when an area
 * has one, comes before the kecamatan; with Biteship it is part of the address line itself. */
export function formatShippingAddress(address: ShippingAddress): string {
  const line = [
    address.recipientName,
    address.phone,
    address.addressLine,
    ...(address.subdistrict ? [address.subdistrict] : []),
    address.district,
    address.city,
    `${address.province} ${address.postalCode}`,
  ].join(", ");
  return address.notes ? `${line}. Catatan: ${address.notes}` : line;
}

/** Copies the address fields one by one, so an object with extra keys (a `customer_addresses`
 * row, say) never leaks its id, customer id or timestamps into the immutable order snapshot. */
export function toShippingAddressSnapshot(address: ShippingAddress): ShippingAddressSnapshot {
  return {
    version: 2,
    recipientName: address.recipientName,
    phone: address.phone,
    addressLine: address.addressLine,
    notes: address.notes,
    shippingAreaId: address.shippingAreaId,
    providerAreaId: address.providerAreaId,
    province: address.province,
    city: address.city,
    district: address.district,
    subdistrict: address.subdistrict,
    postalCode: address.postalCode,
  };
}

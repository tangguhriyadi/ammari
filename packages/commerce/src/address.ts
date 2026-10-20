/** Shipping address input for web checkout and saved addresses (plan §4.3, D12).
 *
 * Plain-text fields: no licence-clean kecamatan + kode pos dataset exists (checked in session 3,
 * 2026-10-20), so `shipping_areas` stays empty and the buyer types city, kecamatan and postal code
 * and picks the province from a fixed list. Phase K may fill `shipping_areas` from Komerce's
 * destination search; until then `shippingAreaId` is always null.
 *
 * Pure functions with no database or server-only imports, so the checkout form can run the same
 * checks in the browser that the server action runs again before writing. */

/** The 38 provinces (Kepmendagri 2025), alphabetical for the checkout select. Province names are
 * stored as text, never matched as reference data by the database. */
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

const PROVINCE_BY_KEY = new Map<string, IndonesianProvince>(
  INDONESIAN_PROVINCES.map((province) => [province.toLowerCase(), province]),
);

export interface ShippingAddress {
  recipientName: string;
  /** `+62...`, matching the `+62[0-9]{8,13}` CHECK on customers, orders and customer_addresses. */
  phone: string;
  province: IndonesianProvince;
  city: string;
  district: string;
  postalCode: string;
  addressLine: string;
  notes: string | null;
}

/** Stored in `orders.shipping_address_snapshot`. `version` lets a later shape (e.g. with a
 * Komerce area id) be told apart from rows written now. */
export interface ShippingAddressSnapshot extends ShippingAddress {
  version: 1;
  shippingAreaId: string | null;
}

export type ShippingAddressField = keyof ShippingAddress;

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
  city: { min: 2, max: 100 },
  district: { min: 2, max: 100 },
  addressLine: { min: 5, max: 500 },
  notes: { max: 200 },
} as const;

/** Validates and normalizes raw form input. Collects every problem (in form order) so checkout
 * can show one alert listing everything to fix. Never throws on malformed input. */
export function parseShippingAddress(input: unknown): ParseShippingAddressResult {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const errors: ShippingAddressError[] = [];

  function requiredText(field: "recipientName" | "city" | "district" | "addressLine", label: string): string {
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

  const provinceRaw = cleanText(raw.province) ?? "";
  const province = PROVINCE_BY_KEY.get(provinceRaw.toLowerCase());
  if (provinceRaw.length === 0) errors.push({ field: "province", message: "Pilih provinsi." });
  else if (!province) errors.push({ field: "province", message: "Provinsi tidak dikenal. Pilih dari daftar." });

  const city = requiredText("city", "Kota atau kabupaten");
  const district = requiredText("district", "Kecamatan");

  // Spaces inside are dropped ("401 32"). Stricter than the DB CHECK `[0-9]{5}`: no Indonesian
  // postal code starts with 0.
  const postalCode = (cleanText(raw.postalCode) ?? "").replace(/\s/g, "");
  if (postalCode.length === 0) errors.push({ field: "postalCode", message: "Kode pos wajib diisi." });
  else if (!/^[1-9][0-9]{4}$/.test(postalCode)) {
    errors.push({ field: "postalCode", message: "Kode pos harus 5 angka." });
  }

  const addressLine = requiredText("addressLine", "Alamat lengkap");

  const notesValue = cleanText(raw.notes) ?? "";
  if (notesValue.length > LIMITS.notes.max) {
    errors.push({ field: "notes", message: `Catatan untuk kurir maksimal ${LIMITS.notes.max} karakter.` });
  }

  if (errors.length > 0 || phone === null || !province) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      recipientName,
      phone,
      province,
      city,
      district,
      postalCode,
      addressLine,
      notes: notesValue.length > 0 ? notesValue : null,
    },
  };
}

/** The single-line text written to `orders.shipping_address`, so admin order detail and packing
 * (which show that column as one line) keep working for web orders. */
export function formatShippingAddress(address: ShippingAddress): string {
  const line = [
    address.recipientName,
    address.phone,
    address.addressLine,
    address.district,
    address.city,
    `${address.province} ${address.postalCode}`,
  ].join(", ");
  return address.notes ? `${line}. Catatan: ${address.notes}` : line;
}

/** Copies the address fields one by one, so an object with extra keys (a `customer_addresses`
 * row, say) never leaks its id, customer id or timestamps into the immutable order snapshot. */
export function toShippingAddressSnapshot(
  address: ShippingAddress,
  shippingAreaId: string | null = null,
): ShippingAddressSnapshot {
  return {
    version: 1,
    recipientName: address.recipientName,
    phone: address.phone,
    province: address.province,
    city: address.city,
    district: address.district,
    postalCode: address.postalCode,
    addressLine: address.addressLine,
    notes: address.notes,
    shippingAreaId,
  };
}

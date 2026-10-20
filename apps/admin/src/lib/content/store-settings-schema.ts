import { z } from "zod";
import {
  ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH,
  HOMEPAGE_META_DESCRIPTION_MAX_LENGTH,
  HOMEPAGE_META_TITLE_MAX_LENGTH,
} from "@ammari/db/storefront-settings";

// ---------- WhatsApp number normalization (docs/plans/storefront-cms.md Phase 2, session 8) ----------
//
// No prior art in this codebase for normalizing an Indonesian phone number — `customers.phone`
// (packages/db/src/schema/customers.ts) is stored exactly as entered, free text, with no
// wa.me-format requirement. This is a new, small, pure function: strips everything but digits,
// then rewrites whichever of the three common input shapes it sees (leading "0", leading "+62",
// already "62...") into the one `wa.me` needs: country code + digits, no "+", no leading 0.
// Returns `null` for anything that doesn't resolve to a plausible Indonesian mobile number
// (628 + 7-11 more digits — covers the real-world 10-13-digit range after the country code)
// rather than guessing, so the caller can turn that into a friendly field error instead of
// silently storing a broken `wa.me` link.

const NORMALIZED_WHATSAPP_PATTERN = /^628\d{7,11}$/;

export function normalizeWhatsappNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  let normalized: string;
  if (digits.startsWith("620")) {
    // A common mistake shape: "+62" pasted together with a leading-0 local number ("62081...").
    // Dropping the one extra "0" after the country code is unambiguous here — a real Indonesian
    // mobile number never has a 0 as the first digit after the country code.
    normalized = `62${digits.slice(3)}`;
  } else if (digits.startsWith("62")) {
    normalized = digits;
  } else if (digits.startsWith("0")) {
    normalized = `62${digits.slice(1)}`;
  } else if (digits.startsWith("8")) {
    normalized = `62${digits}`;
  } else {
    return null;
  }

  return NORMALIZED_WHATSAPP_PATTERN.test(normalized) ? normalized : null;
}

// ---------- Store settings save (save = live, no draft/publish) ----------

// Every field's INPUT type is a plain `string` (an HTML form field left blank still submits ""),
// never `string | null` — each schema below accepts "" and transforms it to `null` as its one
// and only representation of "not set," so the object this module exports never has to reconcile
// two different "empty" shapes at the input boundary.

const whatsappNumberField = z
  .string()
  .trim()
  .refine((value) => value === "" || normalizeWhatsappNumber(value) !== null, {
    message: "Nomor WhatsApp tidak valid. Gunakan format 08xx, +62xx, atau 62xx.",
  })
  .transform((value) => (value === "" ? null : normalizeWhatsappNumber(value)));

const emailField = z
  .string()
  .trim()
  .refine((value) => value === "" || z.string().email().safeParse(value).success, { message: "Email tidak valid." })
  .transform((value) => (value === "" ? null : value));

const optionalTextField = (maxLength: number, message: string) =>
  z
    .string()
    .trim()
    .refine((value) => value.length <= maxLength, { message })
    .transform((value) => (value === "" ? null : value));

/** One line of plain text: any run of whitespace (including a pasted line break) collapses to a
 * single space BEFORE the length check, so what's counted is exactly what the storefront shows. */
const singleLineTextField = (maxLength: number, message: string) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .refine((value) => value.length <= maxLength, { message })
    .transform((value) => (value === "" ? null : value));

export const saveStoreSettingsSchema = z.object({
  whatsappNumber: whatsappNumberField,
  supportEmail: emailField,
  businessAddress: optionalTextField(500, "Alamat terlalu panjang."),
  returnPolicySummary: optionalTextField(300, "Ringkasan terlalu panjang."),
  // Empty text is allowed even while enabled: the storefront simply renders no bar (same as off).
  announcementBarEnabled: z.boolean(),
  announcementBarText: singleLineTextField(
    ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH,
    `Teks pengumuman maksimal ${ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH} karakter agar muat satu baris di HP.`,
  ),
  // Empty = the storefront's default title/description (@ammari/db/storefront-settings).
  homepageMetaTitle: singleLineTextField(HOMEPAGE_META_TITLE_MAX_LENGTH, `Judul beranda maksimal ${HOMEPAGE_META_TITLE_MAX_LENGTH} karakter.`),
  homepageMetaDescription: singleLineTextField(
    HOMEPAGE_META_DESCRIPTION_MAX_LENGTH,
    `Deskripsi beranda maksimal ${HOMEPAGE_META_DESCRIPTION_MAX_LENGTH} karakter.`,
  ),
});

export type SaveStoreSettingsInput = z.infer<typeof saveStoreSettingsSchema>;

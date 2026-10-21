// The account name a buyer types on /account, or takes from an order in the contact offer
// (2026-10-21 sandbox run). Pure: the form checks it first, the server action and the offer again.

export const ACCOUNT_NAME_MAX_LENGTH = 80;

export const ACCOUNT_NAME_MESSAGES = {
  required: "Nama tidak boleh kosong.",
  tooLong: `Nama maksimal ${ACCOUNT_NAME_MAX_LENGTH} karakter.`,
  invalid: "Tulis nama dengan huruf.",
} as const;

export type AccountNameResult = { ok: true; name: string } | { ok: false; message: string };

/** One clean line (control characters and runs of whitespace collapse to one space), at least one
 * letter, at most ACCOUNT_NAME_MAX_LENGTH characters. */
export function parseAccountName(raw: unknown): AccountNameResult {
  const name = (typeof raw === "string" ? raw : "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length === 0) return { ok: false, message: ACCOUNT_NAME_MESSAGES.required };
  if (name.length > ACCOUNT_NAME_MAX_LENGTH) return { ok: false, message: ACCOUNT_NAME_MESSAGES.tooLong };
  if (!/\p{L}/u.test(name)) return { ok: false, message: ACCOUNT_NAME_MESSAGES.invalid };
  return { ok: true, name };
}

// Data minimisation in the customer list (docs/plans/growth.md §8.1, owner answer A5): the list
// shows contacts masked, the detail page shows them in full. Masking happens on the server, so the
// list's payload never carries a full email or phone.

/** "nurul@gmail.com" -> "nu***@gmail.com"; a one- or two-letter name keeps only its first letter. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const keep = local.length > 2 ? 2 : 1;
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

/** "+6281234564567" -> "+62 812 **** 4567": operator prefix and last four digits only. */
export function maskPhone(phone: string): string {
  const national = phone.replace(/^\+62/, "");
  if (national.length < 8) return "+62 ****";
  return `+62 ${national.slice(0, 3)} **** ${national.slice(-4)}`;
}

/** A search query that looks like a phone number, as the stored `+62...` prefix: "0812-3456"
 * -> "+628123456", "62812..." / "+62812..." / "812..." -> "+62812...". Null when it is not a phone query
 * (letters, or fewer than four digits). */
export function phoneSearchPrefix(query: string): string | null {
  const trimmed = query.trim();
  if (!/^\+?[0-9][0-9\s.-]*$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 4) return null;
  if (digits.startsWith("62")) return `+${digits}`;
  if (digits.startsWith("0")) return `+62${digits.slice(1)}`;
  if (digits.startsWith("8")) return `+62${digits}`;
  return null;
}

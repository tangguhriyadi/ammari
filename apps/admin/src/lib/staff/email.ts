import { z } from "zod";

/** RFC 5321's practical maximum for a whole address. */
const MAX_EMAIL_LENGTH = 254;

/** One canonical form for a staff email (docs/plans/roles-staff.md §8): trimmed, Unicode NFC,
 * lowercased. Deliberately does NOT strip Gmail dots or `+tags`: on any other domain those are
 * different mailboxes, so "fixing" them would merge two people. `staff_users.email` is citext as
 * well, so case never decides a match either way; lowercasing here keeps what we store and show
 * stable. */
export function normalizeStaffEmail(raw: string): string {
  return raw.trim().normalize("NFC").toLowerCase();
}

/** The form field for an invite or an email correction: normalises, then validates the result.
 * Whitespace inside the address is refused outright rather than silently removed. */
export const staffEmailSchema = z
  .string({ error: "Email wajib diisi." })
  .transform(normalizeStaffEmail)
  .pipe(
    z
      .string()
      .min(1, "Email wajib diisi.")
      .max(MAX_EMAIL_LENGTH, "Email terlalu panjang.")
      .regex(/^\S+$/, "Email tidak boleh berisi spasi.")
      .email("Format email tidak valid."),
  );

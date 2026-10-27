import { staffEmailSchema } from "@/lib/staff/email";

/** The `?email=` prefill on /login (the staff invite email's button). Returns the normalised
 * address, or null for anything missing, repeated or not a valid email: invalid values are
 * ignored silently, and nothing here looks the address up. */
export function parseLoginEmailParam(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  const parsed = staffEmailSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

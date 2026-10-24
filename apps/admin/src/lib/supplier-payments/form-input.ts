import "server-only";
import { z } from "zod";
import { SUPPLIER_PAYMENT_METHODS } from "@ammari/db/schema";
import { parseRupiah } from "@/lib/products/money";
import { MAX_NOTE_LENGTH, PAYMENT_MESSAGES } from "./payment-records";
import { PRIVATE_UPLOAD_MAX_INPUT_BYTES, PROOF_MESSAGES } from "./messages";

// FormData parsing shared by every "Catat pembayaran" / private-upload action (purchases and
// production). Not a "use server" module: those may export async functions only.

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Input tidak valid.";
}

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    fieldErrors[field] ??= issue.message;
  }
  return fieldErrors;
}

export function text(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

export const noteSchema = z.string().trim().max(MAX_NOTE_LENGTH, PAYMENT_MESSAGES.noteTooLong).optional();

/** The fields every payment form has, whatever it settles. */
export const paymentFieldsSchema = z.object({
  paidAt: z.string().date(PAYMENT_MESSAGES.invalidDate),
  amount: z.string().transform((value, ctx) => {
    const parsed = parseRupiah(value);
    if (parsed === null || parsed <= 0 || !Number.isSafeInteger(parsed)) {
      ctx.addIssue({ code: "custom", message: "Jumlah harus bilangan bulat lebih dari 0." });
      return z.NEVER;
    }
    return parsed;
  }),
  method: z.enum(SUPPLIER_PAYMENT_METHODS, { message: "Pilih metode pembayaran." }),
  note: noteSchema,
});

export function paymentFields(formData: FormData) {
  return {
    paidAt: text(formData, "paidAt"),
    amount: text(formData, "amount") ?? "",
    method: text(formData, "method"),
    note: text(formData, "note"),
  };
}

/** The uploaded file, or an Indonesian refusal before any byte is read. */
export function uploadedFile(formData: FormData, name: string, missingMessage: string): { file: File } | { error: string } {
  const file = formData.get(name);
  if (!(file instanceof File) || file.size === 0) return { error: missingMessage };
  if (file.size > PRIVATE_UPLOAD_MAX_INPUT_BYTES) return { error: PROOF_MESSAGES.tooLarge };
  return { file };
}

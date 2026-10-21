import { normalizeIndonesianPhone, parseShippingAddress } from "@ammari/commerce/address";
import { CHECKOUT_FIELD_MESSAGES } from "@ammari/commerce/checkout-messages";

// Client-side checks of the checkout form (docs/plans/cart-checkout.md §4.3, session 9 note: run
// parseShippingAddress in the browser first so a submit rarely fails validation). Pure and
// client-safe. placeOrder runs every check again on the server with its own data; nothing decided
// here is trusted.

/** The picked area as the combobox knows it: our own shipping_areas id and display label. */
export interface PickedArea {
  id: string;
  label: string;
  hasPostalCode: boolean;
}

/** The logged-in buyer's saved address (lib/checkout/queries.ts loadSavedCheckoutAddress), shown
 * as a summary card with "Ganti alamat" and used to prefill the form. */
export interface SavedCheckoutAddress {
  recipientName: string;
  /** "+62...", as saved. */
  phone: string;
  addressLine: string;
  notes: string;
  postalCode: string;
  /** Null when the saved row has no usable area: the buyer picks it again. */
  area: PickedArea | null;
}

/** A usable voucher in the logged-in dropdown (lib/checkout/queries.ts lists them, best first). */
export interface CheckoutVoucherOption {
  id: string;
  amount: number;
  /** "31 Desember 2026" (WIB). */
  expiresOn: string;
}

export interface CheckoutFormValues {
  contactEmail: string;
  contactPhone: string;
  recipientName: string;
  phone: string;
  addressLine: string;
  notes: string;
  postalCode: string;
  area: PickedArea | null;
  termsAccepted: boolean;
}

/** Field names match placeOrder's fieldErrors (address fields, `contactEmail`, `contactPhone`,
 * `termsAccepted`, `voucherId`), so a server answer lands on the same inputs. */
export interface CheckoutFieldIssue {
  field: string;
  message: string;
}

/** Loose on purpose (the server's zod email is the real check); only catches obvious typos. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every problem at once, in form order (plan §4.3: one alert listing what to fix). `emailLocked`:
 * a session customer's email comes from the account and is not checked here. */
export function validateCheckoutForm(values: CheckoutFormValues, options: { emailLocked: boolean }): CheckoutFieldIssue[] {
  const issues: CheckoutFieldIssue[] = [];

  if (!options.emailLocked) {
    const email = values.contactEmail.trim();
    if (email.length === 0) issues.push({ field: "contactEmail", message: CHECKOUT_FIELD_MESSAGES.emailRequired });
    else if (email.length > 254 || !EMAIL_SHAPE.test(email)) issues.push({ field: "contactEmail", message: CHECKOUT_FIELD_MESSAGES.emailInvalid });
  }

  const contactPhone = values.contactPhone.trim();
  if (contactPhone.length === 0) issues.push({ field: "contactPhone", message: CHECKOUT_FIELD_MESSAGES.phoneRequired });
  else if (!normalizeIndonesianPhone(contactPhone)) issues.push({ field: "contactPhone", message: CHECKOUT_FIELD_MESSAGES.phoneInvalid });

  // The browser does not have the area row, only whether it carries a kode pos. parseShippingAddress
  // reads the row only to decide "picked or not" and "kode pos needed or not"; this stand-in answers
  // exactly those two questions, and its parsed value is thrown away (only the errors are used).
  const standIn = values.area
    ? {
        id: values.area.id,
        province: "",
        city: "",
        district: "",
        subdistrict: null,
        postalCode: values.area.hasPostalCode ? "10000" : null,
        providerAreaId: "browser",
      }
    : null;
  const address = parseShippingAddress(
    { recipientName: values.recipientName, phone: values.phone, addressLine: values.addressLine, notes: values.notes, postalCode: values.postalCode },
    standIn,
  );
  if (!address.ok) issues.push(...address.errors);

  if (!values.termsAccepted) issues.push({ field: "termsAccepted", message: CHECKOUT_FIELD_MESSAGES.termsRequired });
  return issues;
}

export interface CheckoutTotals {
  /** What the voucher takes off: goods only, never more than the subtotal (plan §4.5.6). */
  discount: number;
  /** Subtotal plus the buyer's ongkir (0 until quoted) minus the discount. */
  total: number;
}

/** The summary's figures from server-provided numbers (the cart subtotal, the quote's buyer share,
 * the voucher amount). placeOrder recomputes them and refuses on drift (`expectedTotal`). */
export function computeCheckoutTotals(subtotal: number, buyerShipping: number | null, voucherAmount: number | null): CheckoutTotals {
  const discount = voucherAmount === null ? 0 : Math.min(voucherAmount, subtotal);
  return { discount, total: subtotal + (buyerShipping ?? 0) - discount };
}

/** Identifies the cart a quote was made for: its lines (SKU and quantity) and subtotal. The quote
 * action returns it for the cart it read; the page compares it with the cart it shows, so a quote
 * for lines the page no longer shows (changed in another tab) is never displayed. */
export function cartFingerprint(lines: readonly { sku: string; qty: number }[], subtotal: number): string {
  const key = lines
    .map((line) => `${line.sku}:${line.qty}`)
    .sort()
    .join(",");
  return `${key}|${subtotal}`;
}

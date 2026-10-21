import type { PaymentLine } from "./provider";

// Pure helpers for a payment attempt (docs/plans/cart-checkout.md D7, §4.5.6). No database, no
// server-only import.

/** `MIDTRANS_ORDER_ID_PREFIX`: "" in prod, "DEV-" / "LOCAL-" elsewhere (D7: dev and local share
 * one Sandbox account). Upper-case letters, digits and dashes, at most 16 characters, so the whole
 * id stays inside Midtrans' 50-character, `[A-Za-z0-9-_.~]` order_id. */
export const PAYMENT_ORDER_ID_PREFIX_PATTERN = /^[A-Z0-9-]{0,16}$/;

/** `payments.provider_order_id` for one attempt: `<prefix><order_no>-<attempt>`. */
export function providerOrderId(prefix: string, orderNo: string, attempt: number): string {
  if (!PAYMENT_ORDER_ID_PREFIX_PATTERN.test(prefix)) throw new RangeError("payment order id prefix must be A-Z, 0-9 or '-', at most 16 characters");
  if (!/^ORD-[0-9]{6}-[0-9]{4,}$/.test(orderNo)) throw new RangeError(`not an order number: ${orderNo}`);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  return `${prefix}${orderNo}-${attempt}`;
}

export interface PaymentProductLine {
  sku: string;
  /** e.g. "Gamis Basic Black M". */
  name: string;
  unitPrice: number;
  qty: number;
}

/** Midtrans truncates nothing itself and refuses an item name or id over 50 characters. */
const LINE_TEXT_MAX = 50;

/** Cut by code point, so a name never ends in half an emoji. */
function lineName(name: string): string {
  const chars = Array.from(name);
  return chars.length <= LINE_TEXT_MAX ? name : chars.slice(0, LINE_TEXT_MAX).join("");
}

function assertWholeRupiah(value: number, what: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) throw new RangeError(`${what} must be whole rupiah, got ${value}`);
}

/** The amount the gateway charges, line by line (plan §4.5.6): the product lines, then
 * `{ id: "SHIPPING", name: "Ongkir" }` only when the buyer's share is above 0, then a negative
 * "Voucher" line when a voucher applies. No subsidy line (it is not money the buyer pays) and no
 * fee line (owner decision 3). Throws when the lines do not sum to `grossAmount` (Midtrans
 * refuses a mismatch, and so do we). */
export function buildPaymentLines(params: {
  products: readonly PaymentProductLine[];
  shippingAmount: number;
  discountAmount: number;
  grossAmount: number;
}): PaymentLine[] {
  if (params.products.length === 0) throw new RangeError("a payment needs at least one product line");
  assertWholeRupiah(params.shippingAmount, "shipping amount", true);
  assertWholeRupiah(params.discountAmount, "discount amount", true);
  assertWholeRupiah(params.grossAmount, "gross amount", false);

  const lines: PaymentLine[] = params.products.map((product) => {
    assertWholeRupiah(product.unitPrice, `unit price of ${product.sku}`, false);
    if (!Number.isSafeInteger(product.qty) || product.qty < 1) throw new RangeError(`quantity of ${product.sku} must be a positive integer`);
    if (product.sku.length === 0 || product.sku.length > LINE_TEXT_MAX) throw new RangeError(`line id (SKU) must be 1 to ${LINE_TEXT_MAX} characters`);
    return { id: product.sku, name: lineName(product.name), price: product.unitPrice, quantity: product.qty };
  });
  if (params.shippingAmount > 0) lines.push({ id: "SHIPPING", name: "Ongkir", price: params.shippingAmount, quantity: 1 });
  if (params.discountAmount > 0) lines.push({ id: "VOUCHER", name: "Voucher", price: -params.discountAmount, quantity: 1 });

  const sum = lines.reduce((total, line) => total + line.price * line.quantity, 0);
  if (sum !== params.grossAmount) throw new RangeError(`payment lines sum to ${sum}, gross amount is ${params.grossAmount}`);
  return lines;
}

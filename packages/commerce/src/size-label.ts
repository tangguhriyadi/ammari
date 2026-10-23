/** How a variant size is shown to buyers and staff: the stored code "ALLSIZE" reads "All Size";
 * XS–XL are shown as stored. The one shared copy of the mapping the cart, checkout, payments,
 * stock-reservation and email code each used to carry privately. Plain module (no
 * `server-only`), so client components can use it too. */
export function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

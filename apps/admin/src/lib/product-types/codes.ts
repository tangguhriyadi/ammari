/** Same shape as product_types.code's CHECK (migration 0037): uppercase letters, digits and
 * underscores, starting with a letter, at most 30 characters (e.g. DRESS). Plain module, no
 * `server-only`, so server actions and pages share one definition. */
export const PRODUCT_TYPE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,29}$/;

export function isProductTypeCode(value: string): boolean {
  return PRODUCT_TYPE_CODE_PATTERN.test(value);
}

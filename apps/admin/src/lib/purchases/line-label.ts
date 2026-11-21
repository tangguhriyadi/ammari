/** A purchase line's name in messages and dialogs (docs/plans/fabric-colour-stock.md §4.1): a
 * coloured fabric line reads "Marbella Anti UV, Sage" (UI text never uses an em dash); a
 * colourless line and an accessory line read just the item name, as before colours existed. */
export function purchaseLineLabel(itemName: string, colorName: string | null | undefined): string {
  return colorName ? `${itemName}, ${colorName}` : itemName;
}

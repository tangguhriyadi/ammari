import type { Size } from "@ammari/db/schema";

export interface NewVariantSelection {
  fabricColorId: string;
  sizes: Size[];
}

/** The "Tambah varian" form's submit payload: every selected color x size pair that does NOT
 * already exist on the product, grouped per color, with colors that would add nothing dropped.
 * Derived purely from props (the server's current variant list) on every render, never cached in
 * state, so it can't go stale after a refresh. An empty result means the button stays disabled:
 * there is nothing new to add. */
export function buildNewVariantSelections(
  selectedColorIds: readonly string[],
  sizes: readonly Size[],
  existingSizesByColor: ReadonlyMap<string, ReadonlySet<string>>,
): NewVariantSelection[] {
  const selections: NewVariantSelection[] = [];
  for (const fabricColorId of selectedColorIds) {
    const existing = existingSizesByColor.get(fabricColorId);
    const newSizes = sizes.filter((size) => !existing?.has(size));
    if (newSizes.length > 0) selections.push({ fabricColorId, sizes: newSizes });
  }
  return selections;
}

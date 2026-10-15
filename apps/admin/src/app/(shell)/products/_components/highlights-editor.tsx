"use client";

import { Checkbox, Label } from "@ammari/ui";
import { PRODUCT_HIGHLIGHTS, PRODUCT_HIGHLIGHT_KEYS, type ProductHighlightKey } from "@ammari/db/highlights";

// No "disable once 5 are selected" logic: there are exactly 5 checkboxes for exactly 5 allowed
// keys (owner requirement — a fixed set, not free text, so the storefront can map each one to
// its own icon), so checking every box IS the max; there is no way to exceed it through this
// UI at all. No reordering either — display order is always PRODUCT_HIGHLIGHT_KEYS' own
// canonical order, never something the admin chooses, so `toggle` below always rebuilds the
// array in that order regardless of which box was clicked.
export function HighlightsEditor({
  selected,
  onChange,
}: {
  selected: ProductHighlightKey[];
  onChange: (keys: ProductHighlightKey[]) => void;
}) {
  function toggle(key: ProductHighlightKey, checked: boolean) {
    const next = checked ? [...selected, key] : selected.filter((existing) => existing !== key);
    onChange(PRODUCT_HIGHLIGHT_KEYS.filter((k) => next.includes(k)));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>Keunggulan (maks. 5)</Label>
        <span className="text-sm text-neutral-600" data-testid="highlights-counter">
          {selected.length}/5
        </span>
      </div>
      <div className="flex flex-col">
        {PRODUCT_HIGHLIGHTS.map(({ key, label }) => (
          <Checkbox key={key} label={label} checked={selected.includes(key)} onChange={(event) => toggle(key, event.target.checked)} />
        ))}
      </div>
    </div>
  );
}

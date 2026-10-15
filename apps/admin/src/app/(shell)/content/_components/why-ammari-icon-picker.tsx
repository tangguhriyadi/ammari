"use client";

import { cn } from "@ammari/ui";
import { WHY_AMMARI_ICONS, type WhyAmmariIconKey } from "@ammari/db/why-ammari";
import { WHY_AMMARI_ICON_COMPONENTS } from "./why-ammari-icons";

/** A small grid of the fixed WHY_AMMARI_ICON_KEYS set, each shown with its icon + Indonesian
 * label — single-select, for ONE "Kenapa Ammari" point (docs/plans/storefront-cms.md's own
 * wording: "single-select per point", same closed-set idea as the product highlight
 * checkboxes). `role="radiogroup"`/`role="radio"` — a native radio-button semantic fits a
 * single-select grid better than a plain button group, and gets arrow-key navigation between
 * options for free in most screen readers. */
export function WhyAmmariIconPicker({
  value,
  onChange,
  name,
}: {
  value: WhyAmmariIconKey | null;
  onChange: (icon: WhyAmmariIconKey) => void;
  /** Used only to build unique ids/aria-labels across multiple points' pickers on one page. */
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label="Pilih ikon" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {WHY_AMMARI_ICONS.map(({ key, label }) => {
        const Icon = WHY_AMMARI_ICON_COMPONENTS[key];
        const selected = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            id={`${name}-icon-${key}`}
            onClick={() => onChange(key)}
            className={cn(
              "flex min-h-11 flex-col items-center gap-1.5 rounded-md border p-2 text-center text-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
              selected ? "border-brand bg-brand/5 text-neutral-900" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50",
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

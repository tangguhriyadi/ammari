"use client";

import { forwardRef, useId } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import { FieldError } from "./field-error";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Rendered to the LEFT of the switch (per spec) — pass a stable string, not JSX, so it can
   * also label the switch via `aria-labelledby` without extra wiring. */
  label: string;
  /** Overrides the accessible name without changing the visible text — for a context where
   * `label`'s text is already disambiguated visually (e.g. a table column header) but assistive
   * tech still needs a uniquely identifying name per instance (e.g. "Aktif untuk ukuran S" in a
   * table whose "Aktif" column header already gives sighted users that context). */
  accessibleLabel?: string;
  disabled?: boolean;
  /** Shows a spinner in the thumb and disables interaction, without changing the on/off visual
   * weight the way `disabled` does — use while a save triggered by this switch is in flight. */
  pending?: boolean;
  /** When set, also renders `<input type="hidden" name={name} value="true"|"false">` so a
   * server action reading real `FormData` (not just a direct JS call) still receives this
   * field — most call sites here just read `checked` from the `onCheckedChange` callback, but
   * this keeps the component honest for the form-submission case too. */
  name?: string;
  id?: string;
  className?: string;
  error?: string;
}

/** A native `<button role="switch">`, not a styled checkbox — gets Space/Enter activation and
 * the `switch` accessibility role for free from the browser, rather than reimplementing either. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, label, accessibleLabel, disabled, pending, name, id, className, error },
  ref,
) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const labelId = `${switchId}-label`;
  const errorId = `${switchId}-error`;
  const isDisabled = Boolean(disabled || pending);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span id={labelId} className="text-base text-neutral-900">
          {label}
        </span>
        <button
          ref={ref}
          id={switchId}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={accessibleLabel}
          aria-labelledby={accessibleLabel ? undefined : labelId}
          aria-busy={pending || undefined}
          aria-describedby={error ? errorId : undefined}
          // aria-disabled, not the native `disabled` attribute — `pending` typically starts
          // while this exact button is focused (the user just activated it), and setting
          // native `disabled` on a focused element yanks focus to <body>, right when a
          // keyboard/screen-reader user most needs to know what just happened. Staying
          // focusable but inert (blocked in the click handler below) keeps focus in place.
          aria-disabled={isDisabled || undefined}
          onClick={() => {
            if (isDisabled) return;
            onCheckedChange?.(!checked);
          }}
          className={cn(
            // The button IS the 44px tap target; the track below is purely visual and smaller,
            // centered inside it — keeps the hit area generous without inflating what's drawn.
            "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
            isDisabled && "cursor-not-allowed",
            className,
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150",
              checked ? "border-brand bg-brand" : "border-neutral-400 bg-neutral-200",
              isDisabled && "opacity-60",
            )}
          >
            <span
              className={cn(
                "inline-flex size-5 translate-x-0.5 items-center justify-center rounded-full bg-white shadow-sm",
                "transition-transform duration-150",
                checked && "translate-x-[22px]",
              )}
            >
              {pending && <Loader2 className="size-3 animate-spin text-neutral-500" aria-hidden="true" />}
            </span>
          </span>
        </button>
        {name && <input type="hidden" name={name} value={checked ? "true" : "false"} />}
      </div>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
});

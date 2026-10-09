import { type InputHTMLAttributes, forwardRef, useId } from "react";
import { cn } from "../lib/cn";
import { mergeDescribedBy } from "../lib/describedby";
import { FieldError } from "./field-error";

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  /** Visually hides `label` (still read by screen readers) — for a checkbox-only column where
   * a neighboring cell already shows what the row is. */
  hideLabel?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { id, label, error, hideLabel, className, ...props },
  ref,
) {
  const autoId = useId();
  const checkboxId = id ?? autoId;
  const errorId = `${checkboxId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      {/* The label wraps the whole row so the padded area, not just the 20px box, is clickable —
          keeps a 44px tap target without inflating the visible checkbox. */}
      <label htmlFor={checkboxId} className="flex min-h-11 items-center gap-2 py-2 text-base text-neutral-900">
        <input
          ref={ref}
          id={checkboxId}
          type="checkbox"
          aria-invalid={Boolean(error)}
          aria-describedby={mergeDescribedBy(props["aria-describedby"], error ? errorId : undefined)}
          className={cn(
            "size-5 shrink-0 rounded border-neutral-500 text-brand",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
            error && "border-danger-700",
            className,
          )}
          {...props}
        />
        {hideLabel ? <span className="sr-only">{label}</span> : label}
      </label>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
});

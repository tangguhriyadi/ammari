import { type SelectHTMLAttributes, forwardRef, useId } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";
import { mergeDescribedBy } from "../lib/describedby";
import { FieldError } from "./field-error";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id, error, className, children, ...props },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const errorId = `${selectId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={Boolean(error)}
          aria-describedby={mergeDescribedBy(props["aria-describedby"], error ? errorId : undefined)}
          className={cn(
            "min-h-11 w-full appearance-none rounded-md border border-neutral-500 bg-white px-3 pr-9 text-base text-neutral-900",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand",
            "disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:opacity-60",
            error && "border-danger-700 focus-visible:ring-danger-700",
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-neutral-600"
        />
      </div>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
});

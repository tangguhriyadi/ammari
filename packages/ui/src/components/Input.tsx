import { type InputHTMLAttributes, forwardRef, useId } from "react";
import { cn } from "../lib/cn";
import { mergeDescribedBy } from "../lib/describedby";
import { FieldError } from "./field-error";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { id, error, className, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        aria-describedby={mergeDescribedBy(props["aria-describedby"], error ? errorId : undefined)}
        className={cn(
          "min-h-11 w-full rounded-md border border-neutral-500 bg-white px-3 text-base text-neutral-900",
          "placeholder:text-neutral-500",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand",
          "disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:opacity-60",
          error && "border-danger-700 focus-visible:ring-danger-700",
          className,
        )}
        {...props}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
});

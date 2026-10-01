import { type TextareaHTMLAttributes, forwardRef, useId } from "react";
import { cn } from "../lib/cn";
import { mergeDescribedBy } from "../lib/describedby";
import { FieldError } from "./field-error";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { id, error, className, ...props },
  ref,
) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  const errorId = `${textareaId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={ref}
        id={textareaId}
        aria-invalid={Boolean(error)}
        aria-describedby={mergeDescribedBy(props["aria-describedby"], error ? errorId : undefined)}
        className={cn(
          "min-h-24 w-full rounded-md border border-neutral-500 bg-white px-3 py-2 text-base text-neutral-900",
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

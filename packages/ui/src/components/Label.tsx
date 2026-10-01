import type { LabelHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

/** Pass a matching, explicit `id` to both this and the control it labels (`<Label htmlFor="x">`
 * + `<Input id="x">`) — Input/Select/Textarea/Checkbox generate their own id via `useId()` only
 * when none is passed, and don't expose it back to the caller, so the pairing only works when
 * both sides are given the same id explicitly. */
export function Label({ required, className, children, ...props }: LabelProps) {
  return (
    <label className={cn("text-sm font-medium text-neutral-900", className)} {...props}>
      {children}
      {required && (
        <span aria-hidden="true" className="text-danger-700">
          {" "}
          *
        </span>
      )}
    </label>
  );
}

export { FieldError } from "./field-error";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@ammari/ui";

// Checkout form fields in the storefront's own look (docs/design/storefront.md §3: square corners,
// `--color-line-strong` borders, Jost body text, inline errors in `--color-error`), not
// @ammari/ui's admin inputs (rounded, admin palette). Each field wires its label, hint and error
// to the input (`aria-describedby`, `aria-invalid`), so the one alert at the top and the message
// under the field say the same thing to a screen reader.

export const FIELD_INPUT_CLASS =
  "min-h-12 w-full border border-line-strong bg-bg px-3 text-[15px] text-ink placeholder:text-ink-muted focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink aria-invalid:border-error-border";

export function fieldErrorId(id: string): string {
  return `${id}-error`;
}

function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const list = ids.filter((value): value is string => Boolean(value));
  return list.length > 0 ? list.join(" ") : undefined;
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-error">
      {children}
    </p>
  );
}

interface TextFieldProps extends Omit<ComponentProps<"input">, "id"> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
}

export function TextField({ id, label, hint, error, optional, className, ...props }: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? fieldErrorId(id) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-ink">
        {label}
        {optional && <span className="text-ink-muted"> (opsional)</span>}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId)}
        className={cn(FIELD_INPUT_CLASS, className)}
        {...props}
      />
      {hint && (
        <p id={hintId ?? undefined} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {error && errorId && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

interface TextAreaFieldProps extends Omit<ComponentProps<"textarea">, "id"> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
}

export function TextAreaField({ id, label, hint, error, optional, className, ...props }: TextAreaFieldProps) {
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? fieldErrorId(id) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-ink">
        {label}
        {optional && <span className="text-ink-muted"> (opsional)</span>}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId)}
        className={cn(FIELD_INPUT_CLASS, "min-h-24 py-3", className)}
        {...props}
      />
      {hint && (
        <p id={hintId ?? undefined} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {error && errorId && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

/** "1 · KONTAK" (mockup-checkout.png): the numbered section heading. */
export function SectionHeading({ id, number, children }: { id: string; number: number; children: string }) {
  return (
    <h2 id={id} className="text-[11px] font-medium tracking-[0.24em] text-ink uppercase">
      {number} · {children}
    </h2>
  );
}

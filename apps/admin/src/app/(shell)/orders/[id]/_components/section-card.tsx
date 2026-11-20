import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// Shared building blocks of the order detail page: one card with its title inside, definition-list
// rows (label column about 40%, value beside it, both inside the card), a sub-section divider and a
// collapsible "Detail teknis" area. Display only.

export function SectionCard({ title, id, className = "", testId, children }: { title: string; id?: string; className?: string; testId?: string; children: ReactNode }) {
  return (
    <section aria-label={title} id={id} data-testid={testId} className={`flex scroll-mt-20 flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-4 sm:p-5 ${className}`}>
      <h2 className="text-lg font-semibold text-neutral-900">{title}</h2>
      {children}
    </section>
  );
}

/** A divided block inside a card, with its own small heading. */
export function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
      <h3 className="text-base font-semibold text-neutral-900">{title}</h3>
      {children}
    </div>
  );
}

export function DetailList({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col gap-2.5">{children}</dl>;
}

/** Label and value side by side: the label takes about 40% of the card, the value wraps in the rest. */
export function DetailRow({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-x-3">
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="min-w-0 break-words text-base text-neutral-900" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** Raw identifiers and provider codes, folded away so they do not compete with what staff act on. */
export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-md border border-neutral-200 bg-neutral-50">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm text-neutral-600 [&::-webkit-details-marker]:hidden">
        Detail teknis
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="flex flex-col gap-2.5 px-3 pb-3">{children}</div>
    </details>
  );
}

/** A muted explanatory line. */
export function Note({ children, testId, role }: { children: ReactNode; testId?: string; role?: "status" }) {
  return (
    <p className="text-sm text-neutral-600" data-testid={testId} role={role}>
      {children}
    </p>
  );
}

import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** The shared list-page table shell — desktop/tablet only (`md:block`), paired with `CardList`
 * for phones. Pulled out of /products' table (the reference list page) so every other list page
 * gets the exact same border, header, row-hover, and cell spacing instead of re-typing the
 * class strings. */
export function TableContainer({ children }: { children: ReactNode }) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block">
      <table className="w-full text-left text-base">{children}</table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
      <tr>{children}</tr>
    </thead>
  );
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-4 py-3 font-medium", className)} {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-neutral-100 last:border-0 hover:bg-neutral-50", className)} {...props} />;
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3", className)} {...props} />;
}

/** Phone companion to `TableContainer` — a card per row instead of a wide table. */
export function CardList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("flex flex-col gap-3 md:hidden", className)}>{children}</ul>;
}

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 px-6 py-16 text-center">
      <Icon aria-hidden="true" className="size-10 text-neutral-500" />
      <p className="text-balance text-lg font-semibold text-neutral-900">{title}</p>
      {description && <p className="text-pretty max-w-sm text-base text-neutral-600">{description}</p>}
      {action}
    </div>
  );
}

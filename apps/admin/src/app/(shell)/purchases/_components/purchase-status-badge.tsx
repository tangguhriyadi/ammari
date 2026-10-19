import { Badge, type BadgeVariant } from "@ammari/ui";
import type { PurchaseStatus } from "@ammari/db/schema";
import { PURCHASE_STATUS_LABELS } from "@/lib/purchases/status";

const VARIANTS: Record<PurchaseStatus, BadgeVariant> = {
  ordered: "neutral",
  partially_received: "warning",
  received: "success",
  closed: "neutral",
  cancelled: "danger",
};

export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  return <Badge variant={VARIANTS[status]}>{PURCHASE_STATUS_LABELS[status]}</Badge>;
}

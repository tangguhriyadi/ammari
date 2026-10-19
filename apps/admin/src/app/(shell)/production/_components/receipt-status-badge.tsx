import { Badge, type BadgeVariant } from "@ammari/ui";
import type { ProductionReceiptStatus } from "@ammari/db/schema";
import { PRODUCTION_RECEIPT_STATUS_LABELS } from "@/lib/production/receipt-status";

const VARIANTS: Record<ProductionReceiptStatus, BadgeVariant> = {
  pending: "warning",
  partially_received: "warning",
  received: "success",
  closed: "neutral",
};

/** Output receipt progress of a POSTED batch (S4). Never rendered for a draft, which has no output
 * to receive yet. */
export function ReceiptStatusBadge({ status }: { status: ProductionReceiptStatus }) {
  return <Badge variant={VARIANTS[status]}>{PRODUCTION_RECEIPT_STATUS_LABELS[status]}</Badge>;
}

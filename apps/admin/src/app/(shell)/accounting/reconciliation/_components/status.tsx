import { Badge, type BadgeVariant } from "@ammari/ui";
import { formatBalance } from "@/lib/accounting/format";
import { RECONCILIATION_STATUS_LABELS, type ReconciliationStatus } from "@/lib/accounting/reconciliation-rules";

const STATUS_VARIANT: Record<ReconciliationStatus, BadgeVariant> = { ok: "success", explained: "neutral", review: "warning", mismatch: "danger" };

export function StatusBadge({ status }: { status: ReconciliationStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{RECONCILIATION_STATUS_LABELS[status]}</Badge>;
}

export function Amount({ value }: { value: number }) {
  return <span className="tabular-nums">{formatBalance(value)}</span>;
}

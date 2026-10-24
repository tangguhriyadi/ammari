import { Badge, type BadgeVariant } from "@ammari/ui";
import { PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/supplier-payments/status";

// docs/plans/purchase-payments.md §3.3: muted palette. Belum bayar brick, DP and Lebih bayar
// warning, Lunas olive, Tanpa tagihan neutral.
const VARIANTS: Record<PaymentStatus, BadgeVariant> = {
  no_bill: "neutral",
  unpaid: "danger",
  partial: "warning",
  paid: "success",
  overpaid: "warning",
};

/** Visible to every viewer of the page, with or without finance.view_profit (A8): it carries no
 * amount. */
export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <Badge variant={VARIANTS[status]} data-testid="payment-status-badge">
      {PAYMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

import type { TikTokAfterSaleKind, TikTokAfterSaleReviewReason, TikTokAfterSaleState } from "@ammari/db/schema";

// Indonesian copy for TikTok cancellations and returns (docs/plans/tiktok-shop-integration.md §4.5,
// T6). Pure, safe in client components. TikTok's own status codes are shown translated when known,
// otherwise as sent (a new code TikTok adds must still be readable, never hidden).

export function tiktokRequestKindLabel(kind: TikTokAfterSaleKind, requestType: string | null): string {
  if (kind === "cancellation") return "Pembatalan";
  if (requestType === "REFUND") return "Pengembalian dana saja";
  if (requestType === "RETURN_AND_REFUND") return "Retur barang dan dana";
  if (requestType === "REPLACEMENT") return "Tukar barang";
  return "Retur";
}

const STATUS_LABELS: Record<string, string> = {
  RETURN_OR_REFUND_REQUEST_PENDING: "Menunggu jawaban penjual",
  AWAITING_BUYER_RESPONSE: "Menunggu pembeli",
  AWAITING_BUYER_SHIP: "Menunggu pembeli mengirim barang",
  BUYER_SHIPPED_ITEM: "Barang dikirim pembeli",
  REJECT_RECEIVE_PACKAGE: "Paket ditolak penjual",
  RETURN_OR_REFUND_REQUEST_SUCCESS: "Disetujui",
  RETURN_OR_REFUND_REQUEST_COMPLETE: "Selesai",
  REFUND_OR_RETURN_REQUEST_REJECT: "Ditolak",
  RETURN_OR_REFUND_REQUEST_CANCEL: "Dibatalkan pembeli",
  CANCELLATION_REQUEST_PENDING: "Menunggu jawaban penjual",
  CANCELLATION_REQUEST_SUCCESS: "Disetujui",
  CANCELLATION_REQUEST_COMPLETE: "Selesai",
  CANCELLATION_REQUEST_CANCEL: "Dibatalkan pembeli",
};

export function tiktokRequestStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status]! : status;
}

export const TIKTOK_REVIEW_REASON_LABELS: Record<TikTokAfterSaleReviewReason, string> = {
  unknown_status: "Status dari TikTok belum dikenal",
  unknown_type: "Jenis permintaan belum dikenal",
  replacement: "Permintaan tukar barang",
  lines_unknown: "Barang yang diretur tidak bisa dicocokkan dengan pesanan",
  money_format: "Nominal pengembalian dana tidak terbaca",
  refund_over_total: "Pengembalian dana lebih besar dari total pesanan",
  before_shipping: "Retur untuk pesanan yang belum dikirim di admin",
  after_return: "Pengembalian dana untuk pesanan yang sudah diretur di admin",
  package_rejected: "Paket retur ditolak penjual",
  closed_after_goods: "Retur ditutup padahal barang sudah dikirim balik",
};

export function tiktokNeedsPersonLabel(state: TikTokAfterSaleState | null, reason: TikTokAfterSaleReviewReason | null): string {
  if (state === "partial") return "Retur sebagian barang";
  return reason ? TIKTOK_REVIEW_REASON_LABELS[reason] : "Perlu dicek";
}

const DEADLINE_FORMAT = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "Sabtu, 5 Des 14.00" in Asia/Jakarta. */
export function formatResponseDeadline(date: Date): string {
  const parts = Object.fromEntries(DEADLINE_FORMAT.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.hour}.${parts.minute}`;
}

/** Less than this left: shown as urgent. */
export const RESPONSE_URGENT_MS = 6 * 60 * 60 * 1000;

import { Badge } from "@ammari/ui";

// The packing gate of a TikTok order (docs/plans/tiktok-shop-integration.md §4.4, T5), on the order
// page, the order list and /packing. No hooks, so it renders in server and client components alike.
// The state is computed on the server (tiktokPackingState); only the time is formatted here.

export type TikTokPackingView = { kind: "ready" } | { kind: "wait"; until: Date | null } | { kind: "review" } | { kind: "cancelled" };

const JAKARTA_TIME = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "14.32" in Asia/Jakarta. */
function jakartaTime(date: Date): string {
  const parts = JAKARTA_TIME.formatToParts(date);
  return `${parts.find((part) => part.type === "hour")?.value ?? "00"}.${parts.find((part) => part.type === "minute")?.value ?? "00"}`;
}

export function tiktokPackingLabel(packing: TikTokPackingView): string {
  if (packing.kind === "ready") return "Siap dikemas";
  if (packing.kind === "review") return "Beberapa paket, cek Seller Center";
  if (packing.kind === "cancelled") return "Dibatalkan di TikTok, jangan dikirim";
  return packing.until ? `Tunggu: pembeli masih bisa membatalkan (sampai ${jakartaTime(new Date(packing.until))})` : "Tunggu: pembeli masih bisa membatalkan";
}

export function TikTokPackingBadge({ packing }: { packing: TikTokPackingView }) {
  const variant = packing.kind === "ready" ? "success" : "warning";
  return (
    <Badge variant={variant} className="max-w-full whitespace-normal text-left" data-testid="tiktok-packing-badge">
      {tiktokPackingLabel(packing)}
    </Badge>
  );
}

import Link from "next/link";
import { formatDateTime } from "@ammari/ui/lib";
import type { TikTokBanner } from "@ammari/commerce/tiktok";

// The red/amber notice for a TikTok Shop connection that needs a person (docs/plans/
// tiktok-shop-integration.md §7.3 step 4): on the Integrasi page and on the admin home. Muted
// earth tones (CLAUDE.md), never saturated red.

const TEXT: Record<TikTokBanner["kind"], string> = {
  deauthorized: "Penjual mencabut izin aplikasi di TikTok Shop. Sinkronisasi berhenti dan token sudah dihapus. Hubungkan ulang untuk melanjutkan.",
  reauth_required: "Koneksi TikTok Shop tidak bisa dipakai lagi. Sinkronisasi berhenti. Hubungkan ulang untuk melanjutkan.",
  expiring: "Izin TikTok Shop akan berakhir.",
};

export function TikTokConnectionBanner({ banner, linkToSettings }: { banner: TikTokBanner; linkToSettings: boolean }) {
  const danger = banner.tone === "danger";
  const deadline = banner.kind === "expiring" && banner.deadline ? ` Hubungkan ulang sebelum ${formatDateTime(banner.deadline)} WIB.` : banner.kind === "expiring" ? " Hubungkan ulang secepatnya." : "";
  return (
    <div
      role={danger ? "alert" : "status"}
      data-testid="tiktok-connection-banner"
      className={`flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${
        danger ? "border-danger-200 bg-danger-50 text-danger-700" : "border-warning-200 bg-warning-50 text-warning-700"
      }`}
    >
      <p className="text-pretty">
        <span className="font-semibold">TikTok Shop: </span>
        {TEXT[banner.kind]}
        {deadline}
      </p>
      {linkToSettings && (
        <Link href="/settings/integrations/tiktok" className="shrink-0 font-medium underline underline-offset-2">
          Buka Integrasi TikTok Shop
        </Link>
      )}
    </div>
  );
}

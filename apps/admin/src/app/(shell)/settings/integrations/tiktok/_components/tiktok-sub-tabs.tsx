"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "@ammari/ui";
import { TIKTOK_SKU_PATH, TIKTOK_STOCK_PATH } from "@/lib/integrations/chrome";
import { TIKTOK_TAB } from "@/lib/integrations/tabs";

const SUB_TABS = [
  { label: "Koneksi", href: TIKTOK_TAB.href },
  { label: "Pemetaan SKU", href: TIKTOK_SKU_PATH },
  { label: "Sinkron stok", href: TIKTOK_STOCK_PATH },
];

/** Inside the TikTok Shop tab. Shown whether or not a connection exists, so Pemetaan SKU is always
 * reachable (it has no menu item of its own). Hidden on the other pages under /tiktok. */
export function TikTokSubTabs() {
  const pathname = usePathname();
  if (!SUB_TABS.some((item) => item.href === pathname)) return null;
  return (
    <div className="mb-6">
      <Tabs items={SUB_TABS.map((item) => ({ ...item, isActive: item.href === pathname }))} aria-label="Bagian TikTok Shop" />
    </div>
  );
}

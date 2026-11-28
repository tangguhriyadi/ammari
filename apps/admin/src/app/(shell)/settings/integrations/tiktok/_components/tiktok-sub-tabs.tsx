import { Tabs } from "@ammari/ui";
import { TIKTOK_TAB } from "@/lib/integrations/tabs";

const SUB_TABS = [
  { label: "Koneksi", href: TIKTOK_TAB.href },
  { label: "Pemetaan SKU", href: `${TIKTOK_TAB.href}/sku` },
] as const;

/** Inside the TikTok Shop tab. Shown whether or not a connection exists, so Pemetaan SKU is always
 * reachable (it has no menu item of its own). */
export function TikTokSubTabs({ active }: { active: (typeof SUB_TABS)[number]["label"] }) {
  return (
    <div className="mb-6">
      <Tabs items={SUB_TABS.map((item) => ({ ...item, isActive: item.label === active }))} aria-label="Bagian TikTok Shop" />
    </div>
  );
}

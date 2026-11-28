import type { BreadcrumbItem } from "@ammari/ui";
import { integrationCrumbs } from "./breadcrumb";
import { INTEGRATIONS_PATH, SHOPEE_TAB, TIKTOK_TAB, type IntegrationTab } from "./tabs";

export const TIKTOK_SKU_PATH = `${TIKTOK_TAB.href}/sku`;
/** Sinkron stok (docs/plans/tiktok-stock-sync.md S1): the preview and the stock switch. */
export const TIKTOK_STOCK_PATH = `${TIKTOK_TAB.href}/stock`;

export interface IntegrationChrome {
  tab: IntegrationTab | null;
  crumbs: BreadcrumbItem[];
  description?: string;
}

const TIKTOK_DESCRIPTION = "Hubungkan toko TikTok agar pesanan, retur, dan pencairan dana masuk otomatis ke admin.";

/** What the shared Integrasi top shows on a route, from the pathname alone so it changes without
 * waiting for data. Null for the pages that bring their own breadcrumb and title (TikTok orders,
 * finance, backfill). */
export function integrationChrome(pathname: string): IntegrationChrome | null {
  if (pathname === TIKTOK_TAB.href) return { tab: TIKTOK_TAB, crumbs: integrationCrumbs(TIKTOK_TAB), description: TIKTOK_DESCRIPTION };
  if (pathname === TIKTOK_SKU_PATH) {
    return {
      tab: TIKTOK_TAB,
      crumbs: [...integrationCrumbs(TIKTOK_TAB), { label: "Pemetaan SKU" }],
      description: "Pemetaan SKU: hubungkan setiap SKU di TikTok Shop ke satu varian Ammari, supaya pesanan TikTok bisa masuk ke admin.",
    };
  }
  if (pathname === TIKTOK_STOCK_PATH) {
    return {
      tab: TIKTOK_TAB,
      crumbs: [...integrationCrumbs(TIKTOK_TAB), { label: "Sinkron stok" }],
      description: "Sinkron stok: stok Ammari dikirim ke TikTok Shop (Ammari jadi acuan). Cek pratinjau per SKU sebelum menyalakannya.",
    };
  }
  if (pathname === SHOPEE_TAB.href) {
    return { tab: SHOPEE_TAB, crumbs: integrationCrumbs(SHOPEE_TAB), description: "Shopee terhubung lewat impor file (Pesanan Saya), bukan API." };
  }
  // /settings/integrations itself, on screen only until it redirects to the first tab.
  if (pathname === INTEGRATIONS_PATH) return { tab: null, crumbs: integrationCrumbs(TIKTOK_TAB).slice(0, -1) };
  return null;
}

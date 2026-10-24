import type { MarketplaceAdapter } from "./types";

/** TikTok Shop's export columns are not known yet (docs/plans/marketplace-import.md §2, open O3):
 * every upload is refused before its rows are read. Known cost components for the mapping later:
 * voucher toko -> `sellerVoucher`, komisi platform -> `platform_commission`, komisi afiliasi (per
 * product, `scope: "line"`) -> `affiliate_commission`, seller shipping subsidy ->
 * `seller_shipping_subsidy`. Buyer-paid ongkir is not revenue and is never mapped. */
export const tiktokAdapter: MarketplaceAdapter = {
  channelId: "tiktok",
  label: "TikTok Shop",
  columns: null,
  mappingVerified: false,
  statusMap: {},
  notReadyMessage:
    "Format export TikTok Shop belum dikonfirmasi, jadi file belum bisa diimpor. Kirim contoh baris judul kolom (tanpa data pembeli) ke admin teknis untuk dipasang dulu.",
};

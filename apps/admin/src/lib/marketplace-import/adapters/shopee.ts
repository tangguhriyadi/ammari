import type { MarketplaceAdapter } from "./types";

/**
 * The single switch behind Shopee "Simpan" (owner decision 14, docs/plans/marketplace-import.md
 * §2.1). The columns below come from a public article, NOT from a real Seller Center export.
 * Until a real header row (and 2 or 3 orders' numbers checked against the Seller Center order
 * page) confirms them, the preview works but nothing can be saved. Unlocking: verify, adjust the
 * aliases/scopes here, set this to true, and update the tests that assert the lock.
 */
export const SHOPEE_MAPPING_VERIFIED = false;

export const shopeeAdapter: MarketplaceAdapter = {
  channelId: "shopee",
  label: "Shopee",
  mappingVerified: SHOPEE_MAPPING_VERIFIED,
  lockedMessage:
    "Pemetaan kolom Shopee belum diverifikasi dengan file asli, jadi pesanan belum bisa disimpan. Pratinjau tetap bisa dipakai untuk mengecek file.",
  columns: [
    { field: "channelOrderNo", label: "No. Pesanan", aliases: ["No. Pesanan", "Nomor Pesanan", "Order ID"], required: true },
    { field: "status", label: "Status Pesanan", aliases: ["Status Pesanan", "Order Status"], required: true },
    { field: "orderedAt", label: "Waktu Pesanan Dibuat", aliases: ["Waktu Pesanan Dibuat", "Order Creation Date"], required: true },
    // The VARIANT SKU. Never "SKU Induk" (the parent SKU), which names no single variant.
    { field: "sku", label: "Nomor Referensi SKU", aliases: ["Nomor Referensi SKU", "SKU Reference No."], required: true },
    { field: "qty", label: "Jumlah", aliases: ["Jumlah", "Quantity"], required: true },
    // What the buyer was charged for the row's goods, after product discounts.
    { field: "lineTotal", label: "Total Harga Produk", aliases: ["Total Harga Produk", "Product Subtotal"], required: true },
    // Required: without it omzet would be overstated silently. Order level (repeated per row) is
    // unverified; the double-count rule reports rows that disagree (plan §4).
    { field: "sellerVoucher", label: "Voucher Ditanggung Penjual", aliases: ["Voucher Ditanggung Penjual", "Seller Voucher"], required: true, scope: "order" },
    { field: "fee", component: "admin_fee", label: "Biaya Administrasi", aliases: ["Biaya Administrasi"], required: false, scope: "order" },
    { field: "fee", component: "service_fee", label: "Biaya Layanan", aliases: ["Biaya Layanan"], required: false, scope: "order" },
    { field: "fee", component: "affiliate_commission", label: "Biaya Komisi AMS", aliases: ["Biaya Komisi AMS", "Komisi AMS"], required: false, scope: "order" },
    { field: "productName", label: "Nama Produk", aliases: ["Nama Produk", "Product Name"], required: false },
    { field: "variationName", label: "Nama Variasi", aliases: ["Nama Variasi", "Variation Name"], required: false },
    // Deliberately absent: every buyer and shipping column (username, recipient, phone, address,
    // "Provinsi / Kota", owner decision 9) and buyer-paid ongkir (pass-through, not revenue).
  ],
  statusMap: {
    "belum bayar": { rule: { kind: "unpaid" }, seenInRealFile: false },
    "perlu dikirim": { rule: { kind: "status", status: "to_ship" }, seenInRealFile: false },
    dikirim: { rule: { kind: "status", status: "shipped" }, seenInRealFile: false },
    "sedang dikirim": { rule: { kind: "status", status: "shipped" }, seenInRealFile: false },
    selesai: { rule: { kind: "status", status: "completed" }, seenInRealFile: true },
    batal: { rule: { kind: "status", status: "cancelled" }, seenInRealFile: true },
    "dalam pengembalian": { rule: { kind: "return_pending" }, seenInRealFile: true },
    // A FINAL return status (refund approved, parcel back) is not mapped until it is seen in a real
    // file; until then such orders land in Perlu dicek as an unknown status (plan §3).
  },
};

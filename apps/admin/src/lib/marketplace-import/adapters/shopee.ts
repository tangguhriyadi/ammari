import type { MarketplaceAdapter } from "./types";

/**
 * The single switch behind Shopee "Simpan" (owner decision 14, docs/plans/marketplace-import.md
 * §2.1, §19). The columns below are mapped from the owner's real "Pesanan Saya" export of 27 Nov
 * 2026 (§19.2), but scopes (O1-b), multi-item shape (O1-a) and the price check (O1-d) are still
 * hypotheses until a second real export with shipped, cancelled and multi-item orders is checked
 * (§19.10). Until then the preview works but nothing can be saved. Unlocking is session 7c.
 */
export const SHOPEE_MAPPING_VERIFIED = false;

/** The exact header row of the real export (27 Nov 2026), in order, 49 columns (plan §19.2). The
 * space after the slash in columns 2 and 5 is part of the text. Columns 40-47 are buyer data: they
 * are listed here only to recognise the file, never mapped and never read past the header row. */
export const SHOPEE_HEADER_SIGNATURE = [
  "No. Pesanan",
  "Status Pesanan",
  "Status Pembatalan/ Pengembalian",
  "No. Resi",
  "Opsi Pengiriman",
  "Antar ke counter/ pick-up",
  "Pesanan Harus Dikirimkan Sebelum (Menghindari keterlambatan)",
  "Waktu Pengiriman Diatur",
  "Waktu Pesanan Dibuat",
  "Waktu Pembayaran Dilakukan",
  "Tipe Pesanan",
  "Metode Pembayaran",
  "SKU Induk",
  "Nama Produk",
  "Nomor Referensi SKU",
  "Nama Variasi",
  "Harga Awal",
  "Harga Setelah Diskon",
  "Jumlah",
  "Returned quantity",
  "Subtotal Pesanan",
  "Total Diskon",
  "Diskon Dari Penjual",
  "Diskon Dari Shopee",
  "Berat Produk",
  "Jumlah Produk di Pesan",
  "Total Berat",
  "Voucher Ditanggung Penjual",
  "Cashback Koin",
  "Voucher Ditanggung Shopee",
  "Paket Diskon",
  "Paket Diskon (Diskon dari Shopee)",
  "Paket Diskon (Diskon dari Penjual)",
  "Potongan Koin Shopee",
  "Diskon Kartu Kredit",
  "Ongkos Kirim Dibayar oleh Pembeli",
  "Estimasi Potongan Biaya Pengiriman",
  "Ongkos Kirim Pengembalian Barang",
  "Total Pembayaran",
  "Perkiraan Ongkos Kirim",
  "Catatan dari Pembeli",
  "Catatan",
  "Username (Pembeli)",
  "Nama Penerima",
  "No. Telepon",
  "Alamat Pengiriman",
  "Kota/Kabupaten",
  "Provinsi",
  "Waktu Pesanan Selesai",
] as const;

export const shopeeAdapter: MarketplaceAdapter = {
  channelId: "shopee",
  label: "Shopee",
  mappingVerified: SHOPEE_MAPPING_VERIFIED,
  lockedMessage:
    "Pemetaan kolom Shopee belum diverifikasi dengan file asli, jadi pesanan belum bisa disimpan. Pratinjau tetap bisa dipakai untuk mengecek file.",
  headerSignature: { headers: SHOPEE_HEADER_SIGNATURE, since: "27 Nov 2026" },
  // One alias per column, the exact header text of the real file (§19.2). The English aliases of the
  // article-based mapping are gone: never seen, they could only match a different file.
  columns: [
    { field: "channelOrderNo", label: "No. Pesanan", aliases: ["No. Pesanan"], required: true },
    { field: "status", label: "Status Pesanan", aliases: ["Status Pesanan"], required: true },
    { field: "cancelReturnStatus", label: "Status Pembatalan/ Pengembalian", aliases: ["Status Pembatalan/ Pengembalian"], required: true },
    { field: "orderedAt", label: "Waktu Pesanan Dibuat", aliases: ["Waktu Pesanan Dibuat"], required: true },
    // Display only. "SKU Induk" (the parent SKU) is deliberately absent: it names no single variant
    // and is never a fallback for a blank variant SKU (§19.6).
    { field: "productName", label: "Nama Produk", aliases: ["Nama Produk"], required: false },
    // The VARIANT SKU.
    { field: "sku", label: "Nomor Referensi SKU", aliases: ["Nomor Referensi SKU"], required: true },
    { field: "variationName", label: "Nama Variasi", aliases: ["Nama Variasi"], required: false },
    { field: "listUnitPrice", label: "Harga Awal", aliases: ["Harga Awal"], required: true },
    { field: "unitPriceAfterDiscount", label: "Harga Setelah Diskon", aliases: ["Harga Setelah Diskon"], required: true },
    // Exact alias: "Jumlah Produk di Pesan" (col 25) can never match.
    { field: "qty", label: "Jumlah", aliases: ["Jumlah"], required: true },
    { field: "returnedQty", label: "Returned quantity", aliases: ["Returned quantity"], required: false },
    { field: "fileSubtotal", label: "Subtotal Pesanan", aliases: ["Subtotal Pesanan"], required: false },
    { field: "totalDiscount", label: "Total Diskon", aliases: ["Total Diskon"], required: false },
    // Seller-funded product discount, per row (scope unverified, O1-b): into discount_amount.
    { field: "sellerProductDiscount", label: "Diskon Dari Penjual", aliases: ["Diskon Dari Penjual"], required: true, scope: "line" },
    // Shopee-funded: counts in revenue (owner Q3). Read only for the price check.
    { field: "shopeeProductDiscount", label: "Diskon Dari Shopee", aliases: ["Diskon Dari Shopee"], required: false },
    { field: "sellerVoucher", label: "Voucher Ditanggung Penjual", aliases: ["Voucher Ditanggung Penjual"], required: true, scope: "order" },
    { field: "sellerBundleDiscount", label: "Paket Diskon (Diskon dari Penjual)", aliases: ["Paket Diskon (Diskon dari Penjual)"], required: true, scope: "order" },
    // Deliberately absent (§19.2): fees (the order export has none), every Shopee-funded voucher,
    // coin and bundle discount (they count in revenue, Q3), buyer ongkir and Total Pembayaran (not
    // revenue), shipping/courier/weight columns, and buyer columns 40-47 (decision 9, Q7).
    // "Waktu Pengiriman Diatur" and "Waktu Pesanan Selesai" are read from session 7b.
  ],
  statusMap: {
    "belum bayar": { rule: { kind: "unpaid" }, seenInRealFile: false },
    "perlu dikirim": { rule: { kind: "status", status: "to_ship" }, seenInRealFile: true },
    dikirim: { rule: { kind: "status", status: "shipped" }, seenInRealFile: false },
    "sedang dikirim": { rule: { kind: "status", status: "shipped" }, seenInRealFile: false },
    selesai: { rule: { kind: "status", status: "completed" }, seenInRealFile: true },
    batal: { rule: { kind: "status", status: "cancelled" }, seenInRealFile: true },
    "dalam pengembalian": { rule: { kind: "return_pending" }, seenInRealFile: true },
    // A FINAL return status (refund approved, parcel back) is not mapped until it is seen in a real
    // file; until then such orders land in Perlu dicek as an unknown status (plan §3).
  },
};

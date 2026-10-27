// Indonesian labels for the before/after payload keys of audit_log rows (row snapshots, so these
// are mostly Drizzle column names in camelCase). A key not listed shows as its raw name.

export const FIELD_LABELS: Record<string, string> = {
  id: "ID",
  name: "Nama",
  email: "Email",
  phone: "Telepon",
  address: "Alamat",
  code: "Kode",
  slug: "Slug",
  key: "Kunci",
  title: "Judul",
  status: "Status",
  type: "Jenis",
  kind: "Jenis",
  kinds: "Jenis",
  note: "Catatan",
  notes: "Catatan",
  reason: "Alasan",
  description: "Deskripsi",
  isActive: "Aktif",
  isSystem: "Peran bawaan",
  isVisible: "Tampil",
  sortOrder: "Urutan",
  createdAt: "Dibuat",
  updatedAt: "Diubah",
  createdByStaffUserId: "Dibuat oleh (ID staf)",
  // Orders
  orderId: "Pesanan (ID)",
  orderNo: "No. pesanan",
  channelId: "Kanal",
  channelOrderNo: "No. pesanan marketplace",
  orderDate: "Tanggal pesanan",
  customerId: "Pembeli (ID)",
  buyerUsername: "Username pembeli",
  items: "Item",
  subtotalAmount: "Subtotal",
  discountAmount: "Diskon",
  shippingAmount: "Ongkir",
  totalAmount: "Total",
  courier: "Kurir",
  trackingNumber: "No. resi",
  shippingAddress: "Alamat kirim",
  recipientName: "Nama penerima",
  shippedAt: "Dikirim",
  completedAt: "Selesai",
  cancelledAt: "Dibatalkan",
  returnedAt: "Diretur",
  importBatchId: "Impor (ID)",
  needsAttention: "Perlu dicek",
  flag: "Tanda",
  paymentStatus: "Status pembayaran",
  refundedAmount: "Dana dikembalikan",
  fromStatus: "Status sebelumnya",
  toStatus: "Status baru",
  // Products
  productId: "Produk (ID)",
  productTypeCode: "Jenis produk",
  basePrice: "Harga dasar",
  discountEnabled: "Diskon aktif",
  discountPriceAmount: "Harga diskon",
  discountStartsAt: "Diskon mulai",
  discountEndsAt: "Diskon berakhir",
  storefrontDescription: "Deskripsi di toko",
  isPublishedOnStorefront: "Tampil di toko",
  highlights: "Keunggulan",
  sizeMode: "Mode ukuran",
  closure: "Bukaan",
  sizeChartId: "Tabel ukuran (ID)",
  thumbnailImageId: "Foto utama (ID)",
  shippingWeightGrams: "Berat kirim (gram)",
  allsizeFitNote: "Catatan allsize",
  sku: "SKU",
  skus: "SKU",
  size: "Ukuran",
  sizeGroup: "Kelompok ukuran",
  priceOverrideAmount: "Harga khusus",
  altText: "Teks alternatif",
  storageKey: "Lokasi file",
  width: "Lebar",
  height: "Tinggi",
  fabricId: "Kain (ID)",
  fabricColorId: "Warna kain (ID)",
  hex: "Warna (hex)",
  supplierColorCode: "Kode warna supplier",
  priceAmount: "Harga",
  // Stock, production, purchasing
  qty: "Jumlah",
  valueAmount: "Nilai",
  refType: "Jenis referensi",
  refId: "Referensi (ID)",
  supplier: "Supplier",
  supplierId: "Supplier (ID)",
  supplierName: "Nama supplier",
  purchasedAt: "Tanggal beli",
  voidedAt: "Dibatalkan pada",
  voidReason: "Alasan pembatalan",
  voidsMovementId: "Membatalkan catatan (ID)",
  voidedByStaffUserId: "Dibatalkan oleh (ID staf)",
  accessoryId: "Aksesoris (ID)",
  batchNo: "No. batch",
  lines: "Baris",
  producedAt: "Tanggal produksi",
  postedAt: "Diposting",
  postedByStaffUserId: "Diposting oleh (ID staf)",
  fabricYards: "Kain (yard)",
  fabricCostAmount: "Biaya kain",
  unitCostAmount: "HPP per pcs",
  extraCostsTotal: "Total biaya tambahan",
  accessoryCostTotal: "Total biaya aksesoris",
  totalPcs: "Total pcs",
  unit: "Satuan",
  costType: "Jenis biaya",
  defaultUnitPrice: "Harga satuan bawaan",
  purchaseNo: "No. pembelian",
  purchaseId: "Pembelian (ID)",
  orderedAt: "Tanggal pesan",
  closeReason: "Alasan ditutup",
  reopenReason: "Alasan dibuka lagi",
  receiptNo: "No. penerimaan",
  receivedAt: "Tanggal terima",
  receivedByName: "Diterima oleh",
  paymentNo: "No. pembayaran",
  paidAt: "Tanggal bayar",
  amount: "Jumlah",
  method: "Metode",
  expenseNo: "No. biaya",
  expenseDate: "Tanggal bayar",
  category: "Kategori",
  campaign: "Kampanye",
  proofFileId: "Bukti (ID)",
  recordedByStaffUserId: "Dicatat oleh (ID staf)",
  bankName: "Bank",
  bankAccountNo: "No. rekening",
  bankAccountName: "Nama pemilik rekening",
  // Cards, buyers
  stickerCode: "Kode stiker",
  claimDeadline: "Batas klaim",
  claimedAt: "Diklaim",
  claimedByCustomerId: "Diklaim oleh (ID pembeli)",
  printedByStaffUserId: "Dicetak oleh (ID staf)",
  attemptedByCustomerId: "Dicoba oleh (ID pembeli)",
  ip: "Alamat IP",
  // Content and settings
  content: "Isi",
  rows: "Baris",
  draftBody: "Draf",
  publishedBody: "Isi terbit",
  // Staff and roles
  roleId: "Peran (ID)",
  role: "Peran",
  roleKey: "Kunci peran",
  permissions: "Izin",
  permissionKeys: "Izin",
  invitedAt: "Diundang",
  inviteExpiresAt: "Undangan berlaku sampai",
  invitedByStaffUserId: "Diundang oleh (ID staf)",
  lastLoginAt: "Terakhir masuk",
  deactivatedAt: "Dinonaktifkan",
  // Wrappers used by a few writers ({ purchase, lines }, { void, original })
  purchase: "Pembelian",
  original: "Catatan asli",
  void: "Pembatalan",
};

export function fieldLabel(key: string): string {
  return (Object.hasOwn(FIELD_LABELS, key) && FIELD_LABELS[key]) || key;
}

// Redaction (docs/plans/activity-log.md §1): any key with one of these words, after splitting
// camelCase / snake_case / kebab-case into words, never leaves the server. "tokenHash" ->
// token, hash; "otp_code" -> otp, code; "storageKey" -> storage, key (kept).
const SECRET_WORDS = new Set(["token", "tokens", "secret", "secrets", "password", "passwd", "pwd", "otp", "hash", "salt", "credential", "credentials", "signature", "cookie", "cookies", "apikey", "pin", "passcode", "jwt", "bearer", "authorization", "nonce", "csrf"]);
const SECRET_WORD_PAIRS = [["api", "key"], ["private", "key"], ["access", "key"], ["auth", "code"]];

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  return SECRET_WORD_PAIRS.some(([first, second]) => words.some((word, index) => word === first && words[index + 1] === second));
}

export const REDACTED_TEXT = "(disembunyikan)";

/** A deep copy with every secret-looking key's value replaced by REDACTED_TEXT, at any depth
 * (inside arrays too). */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, isSecretKey(key) ? REDACTED_TEXT : redact(inner)]));
  }
  return value;
}

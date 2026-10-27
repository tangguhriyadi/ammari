import { PERMISSIONS, type PermissionKey } from "@ammari/db/rbac";

// The Indonesian face of the permission catalog (docs/plans/roles-staff.md §4.4), for the Peran
// tab's matrix and the invite form's role summary. Client-safe: no server imports. Every key in
// PERMISSIONS must have an entry (permission-labels.test.ts checks at runtime; PermissionKey is
// a plain string type, so the compiler can't).

export const PERMISSION_AREAS = [
  "Ringkasan",
  "Pesanan",
  "Packing",
  "Stok",
  "Produksi",
  "Produk",
  "Bahan & Pembelian",
  "Keuangan",
  "Pelanggan",
  "Konten",
  "Pengaturan",
  "Staf & Akses",
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number];

export interface PermissionLabel {
  area: PermissionArea;
  label: string;
  /** A permission that exposes money, people or access itself: shown with a "Sensitif" badge
   * and `warning` wherever it can be granted. */
  sensitive?: boolean;
  warning?: string;
}

export const PERMISSION_LABELS: Record<PermissionKey, PermissionLabel> = {
  "overview.view": { area: "Ringkasan", label: "Lihat ringkasan penjualan" },
  "orders.view": { area: "Pesanan", label: "Lihat pesanan" },
  "orders.manage": { area: "Pesanan", label: "Catat pesanan manual, ubah status, tandai dikirim, booking kurir" },
  "orders.import": { area: "Pesanan", label: "Impor file Shopee/TikTok" },
  "packing.print_cards": { area: "Packing", label: "Buka antrean packing, cetak kartu dan stiker" },
  "stock.view": { area: "Stok", label: "Lihat stok produk" },
  "stock.adjust": { area: "Stok", label: "Koreksi stok manual" },
  "production.manage": { area: "Produksi", label: "Kelola batch produksi" },
  "products.manage": { area: "Produk", label: "Kelola produk, varian, harga, foto, bahan, jenis produk" },
  "inventory.view": { area: "Bahan & Pembelian", label: "Lihat stok bahan/aksesoris, supplier, pembelian" },
  "inventory.manage": { area: "Bahan & Pembelian", label: "Kelola supplier dan dokumen pembelian, koreksi, cacat" },
  "inventory.receive": { area: "Bahan & Pembelian", label: "Terima barang datang" },
  "finance.view_profit": {
    area: "Keuangan",
    label: "Lihat HPP, laba, biaya, dan pencairan",
    sensitive: true,
    warning: "Bisa melihat modal dan keuntungan usaha.",
  },
  "supplier_payments.manage": {
    area: "Keuangan",
    label: "Catat/batalkan pembayaran supplier, lihat bukti bayar",
    sensitive: true,
    warning: "Bisa mencatat uang keluar ke supplier.",
  },
  "ads_expenses.manage": { area: "Keuangan", label: "Catat dan batalkan biaya iklan dan operasional, lihat buktinya" },
  "customers.view": { area: "Pelanggan", label: "Lihat data pelanggan (data pribadi)" },
  "customers.manage": { area: "Pelanggan", label: "Catat penarikan persetujuan promo pelanggan" },
  "customers.export": {
    area: "Pelanggan",
    label: "Unduh kontak pelanggan yang setuju promo",
    sensitive: true,
    warning: "Bisa mengunduh data pribadi pelanggan. Hanya untuk promo Ammari sendiri, jangan diunggah ke platform iklan.",
  },
  "vouchers.void": { area: "Pelanggan", label: "Batalkan atau perpanjang voucher" },
  "content.manage": { area: "Konten", label: "Kelola beranda, halaman info, tabel ukuran, deskripsi produk" },
  "settings.manage": { area: "Pengaturan", label: "Ubah target, asumsi biaya, pengaturan" },
  "staff.manage": {
    area: "Staf & Akses",
    label: "Kelola akun staf",
    sensitive: true,
    warning: "Bisa mengundang, menonaktifkan, dan mengganti peran staf.",
  },
  "roles.manage": {
    area: "Staf & Akses",
    label: "Kelola peran dan izin",
    sensitive: true,
    warning: "Hanya untuk Super Admin.",
  },
  "audit_log.view": {
    area: "Staf & Akses",
    label: "Lihat log aktivitas",
    sensitive: true,
    warning: "Hanya untuk Super Admin.",
  },
};

/** Never grantable to any role except super_admin (docs/plans/roles-staff.md §11a): editing
 * roles and reading the audit log stay with the one "keys to the building" account. */
export const SUPER_ADMIN_ONLY_PERMISSION_KEYS: readonly PermissionKey[] = ["roles.manage", "audit_log.view"];

export function permissionLabel(key: string): PermissionLabel {
  return PERMISSION_LABELS[key] ?? { area: "Pengaturan", label: key };
}

export interface PermissionAreaGroup {
  area: PermissionArea;
  keys: PermissionKey[];
}

/** The catalog grouped by area, in PERMISSION_AREAS order, keys in catalog order. */
export function permissionAreaGroups(): PermissionAreaGroup[] {
  return PERMISSION_AREAS.map((area) => ({
    area,
    keys: PERMISSIONS.map((permission) => permission.key).filter((key) => permissionLabel(key).area === area),
  })).filter((group) => group.keys.length > 0);
}

/** Catalog order, so a saved list and a confirmation summary always read the same way. */
export function sortPermissionKeys(keys: Iterable<string>): string[] {
  const order = new Map(PERMISSIONS.map((permission, index) => [permission.key, index]));
  return [...new Set(keys)].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
}

import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  ClipboardCheck,
  Factory,
  FileText,
  History,
  Home,
  LayoutDashboard,
  Megaphone,
  Package,
  PackageCheck,
  Palette,
  Receipt,
  Ruler,
  Settings,
  Shapes,
  ShieldCheck,
  ShoppingBag,
  Store,
  Tags,
  Truck,
  Upload,
  Users,
} from "lucide-react";
import type { PermissionKey } from "@ammari/db/rbac";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  group: string;
  /** The item is shown if the session holds ANY of these keys. */
  permissionKeys: readonly PermissionKey[];
  mobilePrimary: boolean;
}

/** The single source of truth for every admin menu item — label (Indonesian), route, icon,
 * group, and the permission key(s) that gate it. Filtering this list is cosmetic only
 * (see filter.ts's doc comment): every page still calls requirePermission itself. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    label: "Ringkasan",
    href: "/",
    icon: LayoutDashboard,
    group: "Utama",
    permissionKeys: ["overview.view"],
    mobilePrimary: true,
  },
  {
    label: "Pesanan",
    href: "/orders",
    icon: ShoppingBag,
    group: "Operasional",
    permissionKeys: ["orders.view"],
    mobilePrimary: true,
  },
  {
    label: "Packing",
    href: "/packing",
    icon: PackageCheck,
    group: "Operasional",
    permissionKeys: ["packing.print_cards"],
    mobilePrimary: true,
  },
  {
    label: "Impor",
    href: "/import",
    icon: Upload,
    group: "Operasional",
    permissionKeys: ["orders.import"],
    mobilePrimary: false,
  },
  {
    label: "Stok",
    href: "/stock",
    icon: Boxes,
    group: "Operasional",
    permissionKeys: ["stock.view"],
    mobilePrimary: true,
  },
  {
    label: "Pembelian",
    href: "/purchases",
    icon: Receipt,
    group: "Operasional",
    permissionKeys: ["inventory.view", "inventory.manage"],
    mobilePrimary: false,
  },
  {
    label: "Produksi",
    href: "/production",
    icon: Factory,
    group: "Operasional",
    permissionKeys: ["production.manage"],
    mobilePrimary: false,
  },
  {
    // Every goods receipt, both sources (docs/plans/suppliers-goods-receipt.md §7). ClipboardCheck,
    // not PackageCheck: that one is already Packing.
    label: "Penerimaan",
    href: "/receipts",
    icon: ClipboardCheck,
    group: "Operasional",
    permissionKeys: ["inventory.view"],
    mobilePrimary: false,
  },
  {
    label: "Produk",
    href: "/products",
    icon: Package,
    // Renamed from "Katalog" (docs/plans/suppliers-goods-receipt.md D12): the group now holds
    // Supplier too, which is master data rather than anything in the product catalog. Group
    // labels are derived from this file only — nothing asserts the string, and rootCrumbs()
    // reads it straight back out for the breadcrumb.
    group: "Data Master",
    // content.manage too (docs/plans/roles-staff.md, owner answer 5): Admin Konten edits product
    // descriptions from here.
    permissionKeys: ["products.manage", "content.manage"],
    mobilePrimary: false,
  },
  {
    // docs/plans/product-types.md: same permission as Produk (owner decision), no new key.
    label: "Jenis Produk",
    href: "/product-types",
    icon: Shapes,
    group: "Data Master",
    permissionKeys: ["products.manage"],
    mobilePrimary: false,
  },
  {
    label: "Bahan",
    href: "/fabrics",
    icon: Palette,
    group: "Data Master",
    permissionKeys: ["products.manage"],
    mobilePrimary: false,
  },
  {
    label: "Aksesoris",
    href: "/accessories",
    icon: Tags,
    group: "Data Master",
    permissionKeys: ["inventory.view", "inventory.manage"],
    mobilePrimary: false,
  },
  {
    // The supplier master (docs/plans/suppliers-goods-receipt.md, session 1). Same
    // inventory.view/inventory.manage split as Aksesoris — reading the list needs
    // `inventory.view`, every write needs `inventory.manage`; no new permission key.
    label: "Supplier",
    href: "/suppliers",
    icon: Truck,
    group: "Data Master",
    permissionKeys: ["inventory.view", "inventory.manage"],
    mobilePrimary: false,
  },
  {
    // The homepage section editors (docs/plans/storefront-cms.md, session 4) — Hero/Grid Produk/
    // Feature Block/Kenapa Ammari all live under /content itself, not one nav item per section.
    label: "Beranda",
    href: "/content",
    icon: Home,
    group: "Konten",
    permissionKeys: ["content.manage"],
    mobilePrimary: false,
  },
  {
    label: "Tabel Ukuran",
    href: "/content/size-charts",
    icon: Ruler,
    group: "Konten",
    permissionKeys: ["content.manage"],
    mobilePrimary: false,
  },
  {
    // Phase 2 (docs/plans/storefront-cms.md, session 8) — Syarat & ketentuan, Kebijakan
    // privasi, Cara pemesanan, Pengiriman, Pengembalian & penukaran. Same `content.manage` gate
    // as every other Konten item, not a new permission (see this session's own implementation
    // report for why).
    label: "Halaman Info",
    href: "/content/pages",
    icon: FileText,
    group: "Konten",
    permissionKeys: ["content.manage"],
    mobilePrimary: false,
  },
  {
    label: "Pengaturan Toko",
    href: "/content/settings",
    icon: Store,
    group: "Konten",
    permissionKeys: ["content.manage"],
    mobilePrimary: false,
  },
  {
    label: "Iklan & Biaya",
    href: "/ads-expenses",
    icon: Megaphone,
    group: "Pertumbuhan",
    permissionKeys: ["ads_expenses.manage"],
    mobilePrimary: false,
  },
  {
    label: "Pelanggan & Voucher",
    href: "/customers",
    icon: Users,
    group: "Pertumbuhan",
    permissionKeys: ["customers.view"],
    mobilePrimary: false,
  },
  {
    label: "Pengaturan",
    href: "/settings",
    icon: Settings,
    group: "Administrasi",
    permissionKeys: ["settings.manage"],
    mobilePrimary: false,
  },
  {
    label: "Peran & Staf",
    href: "/roles-staff",
    icon: ShieldCheck,
    group: "Administrasi",
    permissionKeys: ["staff.manage", "roles.manage"],
    mobilePrimary: false,
  },
  {
    label: "Log Aktivitas",
    href: "/activity-log",
    icon: History,
    group: "Administrasi",
    permissionKeys: ["audit_log.view"],
    mobilePrimary: false,
  },
] as const;

export const MOBILE_PRIMARY_COUNT = 4;

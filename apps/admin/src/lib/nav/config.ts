import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  Factory,
  History,
  LayoutDashboard,
  Megaphone,
  Package,
  PackageCheck,
  Palette,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Tags,
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
    label: "Produk",
    href: "/products",
    icon: Package,
    group: "Katalog",
    permissionKeys: ["products.manage"],
    mobilePrimary: false,
  },
  {
    label: "Bahan",
    href: "/fabrics",
    icon: Palette,
    group: "Katalog",
    permissionKeys: ["products.manage"],
    mobilePrimary: false,
  },
  {
    label: "Aksesoris",
    href: "/accessories",
    icon: Tags,
    group: "Katalog",
    permissionKeys: ["inventory.view", "inventory.manage"],
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

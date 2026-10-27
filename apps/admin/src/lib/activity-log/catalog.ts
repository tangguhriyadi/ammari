// What every audit_log row means, for Log Aktivitas (docs/plans/activity-log.md §1). Action keys
// are generic ("create", "update", "void"), so a label is keyed by (entity_type, action). Every
// pair written anywhere in apps/*/src or packages/*/src must be listed here: catalog.test.ts scans
// the source and fails on a missing one. An unknown pair still renders (raw key, area "Lainnya").

export const ACTIVITY_AREAS = {
  orders: "Pesanan",
  shipping: "Pengiriman",
  payments: "Pembayaran",
  expenses: "Iklan & Biaya",
  products: "Produk & Diskon",
  stock: "Stok",
  production: "Produksi & Pembelian",
  access: "Staf & Peran",
  import: "Impor",
  content: "Konten",
  settings: "Pengaturan",
  cards: "Kartu & Pembeli",
  other: "Lainnya",
} as const;

export type ActivityArea = keyof typeof ACTIVITY_AREAS;

export function isActivityArea(value: string | undefined | null): value is ActivityArea {
  return typeof value === "string" && Object.hasOwn(ACTIVITY_AREAS, value);
}

/** Who a row with no staff actor came from: the buyer on the main site, or the system (cron,
 * courier webhook, background step). */
export type NonStaffActor = "buyer" | "system";

interface ActionEntry {
  label: string;
  /** Overrides the entity type's area for this one action. */
  area?: ActivityArea;
  /** Only rows written without a staff actor; "system" when omitted. */
  nonStaffActor?: NonStaffActor;
}

interface EntityTypeEntry {
  label: string;
  area: ActivityArea;
  actions: Record<string, ActionEntry>;
}

const BUYER: Pick<ActionEntry, "nonStaffActor"> = { nonStaffActor: "buyer" };

export const AUDIT_CATALOG: Record<string, EntityTypeEntry> = {
  order: {
    label: "Pesanan",
    area: "orders",
    actions: {
      create: { label: "Pesanan dicatat" },
      web_checkout: { label: "Pesanan dibuat di toko online", ...BUYER },
      transition_status: { label: "Status pesanan diubah" },
      update_items: { label: "Isi pesanan diubah" },
      update_shipment_details: { label: "Data pengiriman diubah" },
      complete_without_courier_delivery: { label: "Pesanan diselesaikan tanpa bukti terkirim dari kurir" },
      clear_attention_flag: { label: "Tanda perlu dicek dihapus" },
      import_create: { label: "Pesanan ditambahkan dari impor", area: "import" },
      import_update: { label: "Pesanan diperbarui dari impor", area: "import" },
      cancel_checkout_order: { label: "Pesanan toko online dibatalkan", area: "payments" },
      record_refund: { label: "Pengembalian dana dicatat", area: "payments" },
      request_shipment_booking: { label: "Pemesanan kurir diminta", area: "shipping" },
      book_shipment: { label: "Kurir dipesan", area: "shipping" },
      shipment_booking_failed: { label: "Pemesanan kurir gagal", area: "shipping" },
      refresh_shipment: { label: "Status pengiriman dicek ulang", area: "shipping" },
      request_shipment_cancel: { label: "Pembatalan kurir diminta", area: "shipping" },
      cancel_shipment: { label: "Kurir dibatalkan", area: "shipping" },
      adopt_booked_waybill: { label: "Resi dari kurir dipakai", area: "shipping" },
      track_shipment_poll: { label: "Pelacakan diperbarui (cek berkala)", area: "shipping" },
      track_shipment_webhook: { label: "Pelacakan diperbarui (kabar dari kurir)", area: "shipping" },
      flag_tracking_read_failed: { label: "Pelacakan gagal dibaca", area: "shipping" },
      flag_tracking_stale: { label: "Pelacakan tidak bergerak", area: "shipping" },
    },
  },
  thank_you_card: {
    label: "Kartu ucapan",
    area: "cards",
    actions: {
      print: { label: "Kartu ucapan dicetak" },
      reprint: { label: "Kartu ucapan dicetak ulang" },
      void: { label: "Kartu ucapan dibatalkan" },
      claim: { label: "Voucher diklaim dari kartu", ...BUYER },
      claim_rejected: { label: "Klaim kartu ditolak", ...BUYER },
    },
  },
  customer: {
    label: "Pembeli",
    area: "cards",
    actions: {
      customer_address_deleted: { label: "Alamat tersimpan dihapus", ...BUYER },
      customer_login_link: { label: "Masuk lewat tautan di email pesanan", ...BUYER },
      promo_consent_withdraw: { label: "Penarikan persetujuan promo dicatat" },
    },
  },
  voucher: {
    label: "Voucher",
    area: "cards",
    actions: {
      void: { label: "Voucher dibatalkan" },
      extend: { label: "Voucher diperpanjang" },
    },
  },
  product: {
    label: "Produk",
    area: "products",
    actions: {
      create: { label: "Produk dibuat" },
      update: { label: "Produk diubah" },
      update_storefront: { label: "Tampilan produk di toko diubah" },
      discount_update: { label: "Diskon produk diubah" },
      stock_count: { label: "Stok opname disimpan", area: "stock" },
    },
  },
  product_variant: {
    label: "Varian produk",
    area: "products",
    actions: {
      create: { label: "Varian dibuat" },
      bulk_update: { label: "Varian diubah sekaligus" },
      activate: { label: "Varian diaktifkan" },
      deactivate: { label: "Varian dinonaktifkan" },
    },
  },
  product_image: {
    label: "Foto produk",
    area: "products",
    actions: {
      upload: { label: "Foto diunggah" },
      update: { label: "Foto diubah" },
      reorder: { label: "Urutan foto diubah" },
      delete: { label: "Foto dihapus" },
    },
  },
  product_type: {
    label: "Jenis produk",
    area: "products",
    actions: {
      create: { label: "Jenis produk dibuat" },
      update: { label: "Jenis produk diubah" },
      activate: { label: "Jenis produk diaktifkan" },
      deactivate: { label: "Jenis produk dinonaktifkan" },
    },
  },
  fabric: {
    label: "Kain",
    area: "products",
    actions: {
      create: { label: "Kain dibuat" },
      update: { label: "Kain diubah" },
      delete: { label: "Kain dihapus" },
    },
  },
  fabric_color: {
    label: "Warna kain",
    area: "products",
    actions: {
      create: { label: "Warna kain dibuat" },
      update: { label: "Warna kain diubah" },
      activate: { label: "Warna kain diaktifkan" },
      deactivate: { label: "Warna kain dinonaktifkan" },
      delete: { label: "Warna kain dihapus" },
    },
  },
  stock_movement: {
    label: "Stok produk",
    area: "stock",
    actions: {
      adjust: { label: "Stok produk disesuaikan" },
    },
  },
  fabric_stock_movement: {
    label: "Stok kain",
    area: "stock",
    actions: {
      purchase: { label: "Pembelian kain dicatat" },
      adjust: { label: "Stok kain disesuaikan" },
      void: { label: "Catatan stok kain dibatalkan" },
    },
  },
  accessory: {
    label: "Aksesoris",
    area: "stock",
    actions: {
      create: { label: "Aksesoris dibuat" },
      update: { label: "Aksesoris diubah" },
      activate: { label: "Aksesoris diaktifkan" },
      deactivate: { label: "Aksesoris dinonaktifkan" },
    },
  },
  accessory_movement: {
    label: "Stok aksesoris",
    area: "stock",
    actions: {
      purchase: { label: "Pembelian aksesoris dicatat" },
      adjust: { label: "Stok aksesoris disesuaikan" },
      void: { label: "Catatan stok aksesoris dibatalkan" },
    },
  },
  defect_movement: {
    label: "Barang cacat",
    area: "stock",
    actions: {
      return_to_supplier: { label: "Barang cacat dikembalikan ke supplier" },
      dispose: { label: "Barang cacat dibuang atau dijual" },
      reverse: { label: "Catatan barang cacat dibatalkan" },
    },
  },
  goods_receipt: {
    label: "Penerimaan barang",
    area: "stock",
    actions: {
      receive: { label: "Barang diterima" },
      reverse: { label: "Penerimaan barang dibatalkan" },
    },
  },
  production_batch: {
    label: "Batch produksi",
    area: "production",
    actions: {
      create: { label: "Batch produksi dibuat" },
      update: { label: "Batch produksi diubah" },
      delete: { label: "Batch produksi dihapus" },
      post: { label: "Batch produksi diposting" },
      close: { label: "Batch produksi ditutup" },
      reopen: { label: "Batch produksi dibuka lagi" },
    },
  },
  production_batch_accessory_override: {
    label: "Kebutuhan aksesoris batch",
    area: "production",
    actions: {
      set_override: { label: "Kebutuhan aksesoris batch diubah" },
      clear_override: { label: "Kebutuhan aksesoris batch kembali ke resep" },
    },
  },
  product_accessory_recipe: {
    label: "Resep aksesoris",
    area: "production",
    actions: {
      update: { label: "Resep aksesoris diubah" },
    },
  },
  cost_component: {
    label: "Komponen biaya",
    area: "production",
    actions: {
      create: { label: "Komponen biaya dibuat" },
      update: { label: "Komponen biaya diubah" },
      activate: { label: "Komponen biaya diaktifkan" },
      deactivate: { label: "Komponen biaya dinonaktifkan" },
    },
  },
  purchase: {
    label: "Pembelian",
    area: "production",
    actions: {
      create: { label: "Pembelian dibuat" },
      update: { label: "Pembelian diubah" },
      close: { label: "Pembelian ditutup" },
      reopen: { label: "Pembelian dibuka lagi" },
    },
  },
  supplier: {
    label: "Supplier",
    area: "production",
    actions: {
      create: { label: "Supplier dibuat" },
      update: { label: "Supplier diubah" },
      activate: { label: "Supplier diaktifkan" },
      deactivate: { label: "Supplier dinonaktifkan" },
    },
  },
  supplier_payment: {
    label: "Pembayaran supplier",
    area: "payments",
    actions: {
      record: { label: "Pembayaran supplier dicatat" },
      void: { label: "Pembayaran supplier dibatalkan" },
    },
  },
  business_expense: {
    label: "Biaya",
    area: "expenses",
    actions: {
      record: { label: "Biaya dicatat" },
      void: { label: "Biaya dibatalkan" },
    },
  },
  purchase_attachment: {
    label: "Lampiran pembelian",
    area: "payments",
    actions: {
      attach: { label: "Lampiran pembelian ditambahkan" },
      void: { label: "Lampiran pembelian dibatalkan" },
    },
  },
  import_batch: {
    label: "Impor",
    area: "import",
    actions: {
      import_commit: { label: "Impor disimpan" },
      import_sku_match: { label: "SKU impor dicocokkan" },
    },
  },
  size_chart: {
    label: "Tabel ukuran",
    area: "content",
    actions: {
      create: { label: "Tabel ukuran dibuat" },
      update: { label: "Tabel ukuran diubah" },
      delete: { label: "Tabel ukuran dihapus" },
    },
  },
  info_page: {
    label: "Halaman info",
    area: "content",
    actions: {
      save_draft: { label: "Draf halaman info disimpan" },
      publish: { label: "Halaman info diterbitkan" },
      discard_draft: { label: "Draf halaman info dibuang" },
    },
  },
  storefront_homepage_section: {
    label: "Bagian beranda toko",
    area: "content",
    actions: {
      save_draft: { label: "Draf beranda disimpan" },
      publish: { label: "Beranda diterbitkan" },
      discard_draft: { label: "Draf beranda dibuang" },
    },
  },
  store_settings: {
    label: "Pengaturan toko",
    area: "content",
    actions: {
      update: { label: "Pengaturan toko diubah" },
    },
  },
  sales_goal: {
    label: "Target penjualan",
    area: "settings",
    actions: {
      create: { label: "Target penjualan dibuat" },
      update: { label: "Target penjualan diubah" },
    },
  },
  monthly_bills_reminder: {
    label: "Pengingat biaya bulanan",
    area: "settings",
    actions: {
      update: { label: "Pengingat biaya bulanan diubah" },
    },
  },
  staff_user: {
    label: "Staf",
    area: "access",
    actions: {
      "staff.invite": { label: "Staf diundang" },
      "staff.invite_renew": { label: "Undangan staf dikirim ulang" },
      "staff.invite_email_failed": { label: "Email undangan staf gagal terkirim" },
      "staff.update": { label: "Nama atau email staf diubah" },
      "staff.role_change": { label: "Peran staf diganti" },
      "staff.deactivate": { label: "Staf dinonaktifkan" },
      "staff.reactivate": { label: "Staf diaktifkan lagi" },
      "staff.sessions_revoke": { label: "Semua sesi staf diakhiri" },
    },
  },
  role: {
    label: "Peran",
    area: "access",
    actions: {
      "role.create": { label: "Peran dibuat" },
      "role.update": { label: "Peran diubah" },
      "role.permissions_update": { label: "Izin peran diubah" },
    },
  },
  audit_log: {
    label: "Log aktivitas",
    area: "access",
    actions: {
      export: { label: "Log aktivitas diunduh (CSV)" },
    },
  },
};

export interface ActionDescription {
  label: string;
  area: ActivityArea;
  entityTypeLabel: string;
  known: boolean;
  nonStaffActor: NonStaffActor;
}

/** Never throws: an unknown entity type or action shows its raw key under "Lainnya" (or under
 * the entity type's own area when only the action is new). */
export function describeAction(entityType: string, action: string): ActionDescription {
  const type = Object.hasOwn(AUDIT_CATALOG, entityType) ? AUDIT_CATALOG[entityType] : undefined;
  const entry = type && Object.hasOwn(type.actions, action) ? type.actions[action] : undefined;
  return {
    label: entry?.label ?? action,
    area: entry?.area ?? type?.area ?? "other",
    entityTypeLabel: type?.label ?? entityType,
    known: entry !== undefined,
    nonStaffActor: entry?.nonStaffActor ?? "system",
  };
}

export const NON_STAFF_ACTOR_LABELS: Record<NonStaffActor, string> = { buyer: "Pembeli", system: "Sistem" };

/** Which rows belong to `area`, as data the query layer turns into SQL: whole entity types (minus
 * their actions that moved to another area), single pairs that moved in, and for "other" every
 * entity type the catalog does not know. Mirrors describeAction exactly (catalog.test.ts). */
export interface AreaMembership {
  entityTypes: { entityType: string; exceptActions: string[] }[];
  pairs: { entityType: string; action: string }[];
  /** "other" only: every entity type the catalog knows, to exclude. */
  excludeEntityTypes: string[] | null;
}

export function areaMembership(area: ActivityArea): AreaMembership {
  const entityTypes: AreaMembership["entityTypes"] = [];
  const pairs: AreaMembership["pairs"] = [];
  for (const [entityType, type] of Object.entries(AUDIT_CATALOG)) {
    const actions = Object.entries(type.actions);
    if (type.area === area) {
      entityTypes.push({ entityType, exceptActions: actions.filter(([, entry]) => entry.area && entry.area !== area).map(([action]) => action) });
    } else {
      for (const [action, entry] of actions) if (entry.area === area) pairs.push({ entityType, action });
    }
  }
  return { entityTypes, pairs, excludeEntityTypes: area === "other" ? Object.keys(AUDIT_CATALOG) : null };
}

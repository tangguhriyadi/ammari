import { crc32, deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";

// Synthetic marketplace export fixtures (docs/plans/marketplace-import.md §14). Everything here is
// invented: order numbers, SKUs and the buyer columns, whose obviously fake values let a test assert
// that none of them ever leaves the parser. No real export, and no binary fixture, is committed.

export type FixtureCell = string | number | boolean | null | { formula: string; cached: string | number };

/** The fake buyer data every Shopee fixture row carries in columns 40-47; must never appear in parser
 * output. */
export const FAKE_BUYER = {
  buyerNote: "Catatan pembeli rahasia zz",
  note: "Catatan penjual rahasia zz",
  username: "pembeli_rahasia_zz",
  name: "Nama Penerima Rahasia",
  phone: "6281299990000",
  address: "Jl. Rahasia No. 99, Kelurahan Fiktif",
  city: "KOTA FIKTIF",
  province: "PROVINSI FIKTIF",
} as const;

/** The exact header row of the real Shopee "Pesanan Saya" export of 27 Nov 2026, in order (plan
 * §19.2). The space after the slash in columns 2 and 5 is part of the text. */
export const SHOPEE_HEADER = [
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

export type ShopeeHeader = (typeof SHOPEE_HEADER)[number];

/** The column index of a Shopee header. */
export function shopeeColumn(header: ShopeeHeader): number {
  return SHOPEE_HEADER.indexOf(header);
}

/** A money value as the real file writes it: text, "." thousands, no decimals. A string is taken as
 * is (to test what the parser refuses); null is a blank cell. */
export type FixtureMoney = number | string | null;

export function rupiahText(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`fixture: not a whole rupiah amount: ${amount}`);
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function moneyCell(value: FixtureMoney): FixtureCell {
  if (value === null) return "";
  return typeof value === "number" ? rupiahText(value) : value;
}

export interface FixtureLine {
  sku: string | null;
  qty: number | string;
  /** Harga Awal x Jumlah. Harga Awal defaults to lineTotal / qty (must divide evenly). */
  lineTotal?: number;
  /** Harga Awal (per piece), overrides the one derived from lineTotal. */
  listUnitPrice?: FixtureMoney;
  /** Harga Setelah Diskon (per piece); defaults to Harga Awal - Total Diskon / Jumlah. */
  unitPriceAfterDiscount?: FixtureMoney;
  /** Total Diskon of the row; defaults to seller + Shopee discount. */
  totalDiscount?: FixtureMoney;
  /** Diskon Dari Penjual of the row. */
  sellerDiscount?: number;
  /** Diskon Dari Shopee of the row. */
  shopeeDiscount?: number;
  returnedQty?: number | string;
  /** Subtotal Pesanan; defaults to Harga Setelah Diskon x Jumlah. */
  fileSubtotal?: FixtureMoney;
  productName?: string;
  variationName?: string;
  /** SKU Induk: never read. */
  parentSku?: string;
}

export interface FixtureOrder {
  orderNo: string;
  status?: string;
  /** Status Pembatalan/ Pengembalian; blank by default. */
  cancelReturnStatus?: string;
  /** Text "YYYY-MM-DD HH:MM", or a number to test that serials are refused. */
  orderedAt?: string | number;
  shippedAt?: string;
  completedAt?: string;
  lines: FixtureLine[];
  sellerVoucher?: FixtureMoney;
  /** Paket Diskon (Diskon dari Penjual). */
  sellerBundleDiscount?: FixtureMoney;
  /** Shopee-funded columns: count in revenue (owner Q3), never read. */
  shopeeVoucher?: number;
  shopeeBundleDiscount?: number;
  shopeeCoins?: number;
  coinCashback?: number;
}

function listUnitPriceOf(line: FixtureLine): FixtureMoney {
  if (line.listUnitPrice !== undefined) return line.listUnitPrice;
  if (line.lineTotal === undefined) throw new Error("fixture: a line needs listUnitPrice or lineTotal");
  // A deliberately invalid Jumlah ("dua"): the row is an error anyway, any price will do.
  if (typeof line.qty !== "number") return line.lineTotal;
  if (line.lineTotal % line.qty !== 0) throw new Error(`fixture: lineTotal ${line.lineTotal} is not ${line.qty} x a whole Harga Awal`);
  return line.lineTotal / line.qty;
}

/** One row per line, order-level values repeated on every row, every cell text, the exact 49 headers
 * in the real order (plan §19.1). Buyer columns 40-47 carry FAKE_BUYER. */
export function shopeeRows(orders: readonly FixtureOrder[]): FixtureCell[][] {
  const rows: FixtureCell[][] = [[...SHOPEE_HEADER]];
  for (const order of orders) {
    const orderPieces = order.lines.reduce((sum, line) => sum + (typeof line.qty === "number" ? line.qty : 0), 0);
    for (const line of order.lines) {
      const listUnitPrice = listUnitPriceOf(line);
      const qty = typeof line.qty === "number" ? line.qty : null;
      const sellerDiscount = line.sellerDiscount ?? 0;
      const shopeeDiscount = line.shopeeDiscount ?? 0;
      const totalDiscount = line.totalDiscount !== undefined ? line.totalDiscount : sellerDiscount + shopeeDiscount;
      let after: FixtureMoney;
      if (line.unitPriceAfterDiscount !== undefined) after = line.unitPriceAfterDiscount;
      else if (typeof listUnitPrice === "number" && typeof totalDiscount === "number" && qty !== null && totalDiscount % qty === 0) after = listUnitPrice - totalDiscount / qty;
      else if (typeof listUnitPrice === "number" && totalDiscount === 0) after = listUnitPrice;
      else throw new Error("fixture: give unitPriceAfterDiscount explicitly for this line");
      const subtotal = line.fileSubtotal !== undefined ? line.fileSubtotal : typeof after === "number" && qty !== null ? after * qty : null;
      const row: FixtureCell[] = [
        order.orderNo,
        order.status ?? "Selesai",
        order.cancelReturnStatus ?? "",
        "SPXID0000000001",
        "SPX Standard",
        "Pick-up",
        "2026-10-25 23:59",
        order.shippedAt ?? "",
        order.orderedAt ?? "2026-10-23 14:05",
        "2026-10-23 14:06",
        "Normal",
        "ShopeePay",
        line.parentSku ?? "INDUK-UJI",
        line.productName ?? "Gamis Uji",
        line.sku ?? "",
        line.variationName ?? "Sage,M",
        moneyCell(listUnitPrice),
        moneyCell(after),
        String(line.qty),
        line.returnedQty === undefined ? "0" : String(line.returnedQty),
        moneyCell(subtotal),
        moneyCell(totalDiscount),
        rupiahText(sellerDiscount),
        rupiahText(shopeeDiscount),
        "700 gr",
        String(orderPieces + 90),
        `${700 * orderPieces} gr`,
        moneyCell(order.sellerVoucher === undefined ? 0 : order.sellerVoucher),
        rupiahText(order.coinCashback ?? 0),
        rupiahText(order.shopeeVoucher ?? 5_000),
        "N",
        rupiahText(order.shopeeBundleDiscount ?? 0),
        moneyCell(order.sellerBundleDiscount === undefined ? 0 : order.sellerBundleDiscount),
        rupiahText(order.shopeeCoins ?? 0),
        "0",
        "12.000",
        "0",
        "0",
        "333.333",
        "12.000",
        FAKE_BUYER.buyerNote,
        FAKE_BUYER.note,
        FAKE_BUYER.username,
        FAKE_BUYER.name,
        FAKE_BUYER.phone,
        FAKE_BUYER.address,
        FAKE_BUYER.city,
        FAKE_BUYER.province,
        order.completedAt ?? "",
      ];
      if (row.length !== SHOPEE_HEADER.length) throw new Error("fixture: row length differs from the header");
      rows.push(row);
    }
  }
  return rows;
}

function toSheet(rows: readonly FixtureCell[][]): XLSX.WorkSheet {
  const plain = rows.map((row) => row.map((cell) => (cell !== null && typeof cell === "object" ? cell.cached : cell)));
  const sheet = XLSX.utils.aoa_to_sheet(plain);
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell !== null && typeof cell === "object") {
        const target = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject;
        target.f = cell.formula;
      }
    }),
  );
  return sheet;
}

export interface XlsxFixtureOptions {
  sheetName?: string;
  /** Sheets placed BEFORE the main one. */
  sheetsBefore?: { name: string; rows: FixtureCell[][] }[];
  date1904?: boolean;
}

export function xlsxBytes(rows: readonly FixtureCell[][], options: XlsxFixtureOptions = {}): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const extra of options.sheetsBefore ?? []) XLSX.utils.book_append_sheet(book, toSheet(extra.rows), extra.name);
  XLSX.utils.book_append_sheet(book, toSheet(rows), options.sheetName ?? "orders");
  if (options.date1904) book.Workbook = { ...book.Workbook, WBProps: { ...book.Workbook?.WBProps, date1904: true } };
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer);
}

export function csvBytes(rows: readonly (string | number | null)[][], options: { delimiter?: string; bom?: boolean; sepLine?: boolean } = {}): Uint8Array {
  const delimiter = options.delimiter ?? ",";
  const escape = (cell: string | number | null) => {
    const text = cell === null ? "" : String(cell);
    return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const body = rows.map((row) => row.map(escape).join(delimiter)).join("\r\n");
  const text = `${options.bom ? "\ufeff" : ""}${options.sepLine ? `sep=${delimiter}\r\n` : ""}${body}\r\n`;
  return new TextEncoder().encode(text);
}

export interface ZipFixtureEntry {
  name: string;
  data: Uint8Array;
  /** Lie in both headers about the uncompressed size (a zip bomb's trick). */
  declaredSize?: number;
  stored?: boolean;
  /** Make the LOCAL header disagree with the central one (the reader-differential attacks). */
  localMethod?: number;
  localName?: string;
  /** Also declare the central method as this (e.g. 0 "stored" over real deflate data). */
  centralMethod?: number;
}

/** A hand-built zip, for the guard's tests: real deflate, optionally lying about sizes. */
export function zipBytes(entries: readonly ZipFixtureEntry[], options: { comment?: Uint8Array } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const method = entry.stored ? 0 : 8;
    const compressed = entry.stored ? Buffer.from(entry.data) : deflateRawSync(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.localMethod ?? method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.centralMethod ?? method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.centralMethod === 0 ? compressed.length : size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, localName, compressed);
    centrals.push(central, name);
    offset += local.length + localName.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  const comment = Buffer.from(options.comment ?? new Uint8Array());
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, centralDirectory, end, comment]));
}

/** The two entries the guard requires before it calls anything an xlsx. */
export const XLSX_SKELETON: readonly ZipFixtureEntry[] = [
  { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
  { name: "xl/workbook.xml", data: new TextEncoder().encode("<workbook/>") },
];

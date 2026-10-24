import { crc32, deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";

// Synthetic marketplace export fixtures (docs/plans/marketplace-import.md §14). Everything here is
// invented: order numbers, SKUs and the buyer columns, whose obviously fake values let a test assert
// that none of them ever leaves the parser. No real export, and no binary fixture, is committed.

export type FixtureCell = string | number | boolean | null | { formula: string; cached: string | number };

/** The fake buyer data every Shopee fixture row carries; must never appear in parser output. */
export const FAKE_BUYER = {
  username: "pembeli_rahasia_zz",
  name: "Nama Penerima Rahasia",
  phone: "6281299990000",
  address: "Jl. Rahasia No. 99, Kelurahan Fiktif",
  city: "KOTA FIKTIF",
  province: "Provinsi Fiktif / Kota Fiktif",
} as const;

/** Shopee's reference columns (plan §2.1, unverified) with buyer and shipping columns mixed in, in
 * a plausible Seller Center order. */
export const SHOPEE_HEADER = [
  "No. Pesanan",
  "Status Pesanan",
  "Username (Pembeli)",
  "Waktu Pesanan Dibuat",
  "Nama Produk",
  "Nama Variasi",
  "Nomor Referensi SKU",
  "SKU Induk",
  "Jumlah",
  "Total Harga Produk",
  "Voucher Ditanggung Penjual",
  "Voucher Ditanggung Shopee",
  "Ongkos Kirim Dibayar oleh Pembeli",
  "Biaya Administrasi",
  "Biaya Layanan",
  "Biaya Komisi AMS",
  "Nama Penerima",
  "No. Telepon",
  "Alamat Pengiriman",
  "Kota/Kabupaten",
  "Provinsi / Kota",
] as const;

export interface FixtureLine {
  sku: string | null;
  qty: number | string;
  lineTotal: number | string;
  productName?: string;
  variationName?: string;
}

export interface FixtureOrder {
  orderNo: string;
  status?: string;
  orderedAt?: string | number;
  lines: FixtureLine[];
  sellerVoucher?: number | string | null;
  adminFee?: number | string | null;
  serviceFee?: number | string | null;
  affiliateFee?: number | string | null;
}

/** One row per line, order-level values repeated on every row (Shopee's shape, plan §4). */
export function shopeeRows(orders: readonly FixtureOrder[]): FixtureCell[][] {
  const rows: FixtureCell[][] = [[...SHOPEE_HEADER]];
  for (const order of orders) {
    for (const line of order.lines) {
      rows.push([
        order.orderNo,
        order.status ?? "Selesai",
        FAKE_BUYER.username,
        order.orderedAt ?? "2026-10-23 14:05",
        line.productName ?? "Gamis Uji",
        line.variationName ?? "Sage,M",
        line.sku,
        "INDUK-UJI",
        line.qty,
        line.lineTotal,
        order.sellerVoucher === undefined ? 0 : order.sellerVoucher,
        5000,
        12000,
        order.adminFee === undefined ? 0 : order.adminFee,
        order.serviceFee === undefined ? 0 : order.serviceFee,
        order.affiliateFee === undefined ? 0 : order.affiliateFee,
        FAKE_BUYER.name,
        FAKE_BUYER.phone,
        FAKE_BUYER.address,
        FAKE_BUYER.city,
        FAKE_BUYER.province,
      ]);
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

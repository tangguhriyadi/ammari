import { crc32, inflateRawSync } from "node:zlib";
import { MAX_ENTRY_UNCOMPRESSED_BYTES, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from "./limits";

// An .xlsx is a zip. The spreadsheet library NEVER sees the uploaded bytes (docs/plans/
// marketplace-import.md §10): this module walks the zip itself, inflates every entry once under
// a hard output cap (`maxOutputLength`), and returns a freshly built STORED-only zip of exactly
// those checked bytes, which is what SheetJS then reads. Zip readers disagree about which header
// to trust (SheetJS trusts the local file header, this walk the central directory); rebuilding
// removes that disagreement entirely: a crafted file whose local and central headers differ is
// refused, and even an unnoticed difference could only change bytes we already inflated and
// counted. Found by the security review of session 1 (central "stored" over a local "deflate"
// bomb passed an earlier check-only version of this guard).
//
// Also refused: zip64, multi-disk, encryption, compression other than stored/deflate, duplicate
// or non-UTF-8 names, an entry whose real size differs from its declared size, anything out of
// bounds, a zip comment that does not end exactly at the end of the file. Names are only compared,
// never used as paths.

export type ZipGuardResult = { ok: true; zip: Uint8Array } | { ok: false; reason: "unsafe" | "not_xlsx" };

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DATA_DESCRIPTOR = 0x8;

/** Entries every Office Open XML workbook has; anything else (ODS, xlsb, a plain zip) is not one. */
const REQUIRED_ENTRIES = ["[Content_Types].xml", "xl/workbook.xml"];

class UnsafeZip extends Error {}

function u16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new UnsafeZip("out of bounds");
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new UnsafeZip("out of bounds");
  return view.getUint32(offset, true);
}

/** The end record, which must end exactly at the end of the file (its comment included): a fake
 * end record hidden inside a comment would otherwise be a second, different reading of the file. */
function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - END_RECORD_SIZE - MAX_COMMENT_SIZE);
  for (let offset = view.byteLength - END_RECORD_SIZE; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    if (offset + END_RECORD_SIZE + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  throw new UnsafeZip("no end of central directory");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

interface CheckedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
}

/** A stored-only zip (no compression, no extra fields, no comments) of the given entries. */
function buildStoredZip(entries: readonly CheckedEntry[]): Uint8Array {
  let localSize = 0;
  let centralSize = 0;
  for (const entry of entries) {
    localSize += 30 + entry.nameBytes.length + entry.data.length;
    centralSize += 46 + entry.nameBytes.length;
  }
  const out = new Uint8Array(localSize + centralSize + END_RECORD_SIZE);
  const view = new DataView(out.buffer);
  let cursor = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];
  for (const entry of entries) {
    const crc = crc32(entry.data);
    offsets.push(cursor);
    crcs.push(crc);
    view.setUint32(cursor, LOCAL_FILE_HEADER, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 0x800, true); // UTF-8 names
    view.setUint32(cursor + 14, crc, true);
    view.setUint32(cursor + 18, entry.data.length, true);
    view.setUint32(cursor + 22, entry.data.length, true);
    view.setUint16(cursor + 26, entry.nameBytes.length, true);
    out.set(entry.nameBytes, cursor + 30);
    out.set(entry.data, cursor + 30 + entry.nameBytes.length);
    cursor += 30 + entry.nameBytes.length + entry.data.length;
  }
  const centralStart = cursor;
  entries.forEach((entry, index) => {
    view.setUint32(cursor, CENTRAL_FILE_HEADER, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 8, 0x800, true);
    view.setUint32(cursor + 16, crcs[index]!, true);
    view.setUint32(cursor + 20, entry.data.length, true);
    view.setUint32(cursor + 24, entry.data.length, true);
    view.setUint16(cursor + 28, entry.nameBytes.length, true);
    view.setUint32(cursor + 42, offsets[index]!, true);
    out.set(entry.nameBytes, cursor + 46);
    cursor += 46 + entry.nameBytes.length;
  });
  view.setUint32(cursor, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(cursor + 8, entries.length, true);
  view.setUint16(cursor + 10, entries.length, true);
  view.setUint32(cursor + 12, cursor - centralStart, true);
  view.setUint32(cursor + 16, centralStart, true);
  return out;
}

export function checkXlsxZip(bytes: Uint8Array): ZipGuardResult {
  try {
    if (bytes.byteLength < END_RECORD_SIZE) throw new UnsafeZip("too short");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = findEndOfCentralDirectory(view);
    const diskNumber = u16(view, end + 4);
    const centralDirectoryDisk = u16(view, end + 6);
    const entriesOnDisk = u16(view, end + 8);
    const entryCount = u16(view, end + 10);
    const centralDirectoryOffset = u32(view, end + 16);
    // Multi-disk archives and zip64 (0xFFFF / 0xFFFFFFFF markers) are never an export file.
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
      throw new UnsafeZip("zip64 or multi-disk");
    }
    if (entryCount === 0 || entryCount > MAX_ZIP_ENTRIES) throw new UnsafeZip("entry count");

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const names = new Set<string>();
    const entries: CheckedEntry[] = [];
    let total = 0;
    let cursor = centralDirectoryOffset;
    for (let index = 0; index < entryCount; index++) {
      if (u32(view, cursor) !== CENTRAL_FILE_HEADER) throw new UnsafeZip("central header");
      const flags = u16(view, cursor + 8);
      const method = u16(view, cursor + 10);
      const compressedSize = u32(view, cursor + 20);
      const uncompressedSize = u32(view, cursor + 24);
      const nameLength = u16(view, cursor + 28);
      const extraLength = u16(view, cursor + 30);
      const commentLength = u16(view, cursor + 32);
      const localOffset = u32(view, cursor + 42);
      if (cursor + 46 + nameLength > bytes.byteLength) throw new UnsafeZip("name out of bounds");
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = decoder.decode(nameBytes);
      cursor += 46 + nameLength + extraLength + commentLength;

      if (flags & FLAG_ENCRYPTED) throw new UnsafeZip("encrypted");
      if (method !== 0 && method !== 8) throw new UnsafeZip("compression method");
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new UnsafeZip("zip64 entry");
      if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES || total + uncompressedSize > MAX_UNCOMPRESSED_BYTES) throw new UnsafeZip("declared size");
      if (names.has(name)) throw new UnsafeZip("duplicate entry");
      names.add(name);

      // The local header must tell the same story as the central one.
      if (u32(view, localOffset) !== LOCAL_FILE_HEADER) throw new UnsafeZip("local header");
      const localFlags = u16(view, localOffset + 6);
      const localMethod = u16(view, localOffset + 8);
      const localNameLength = u16(view, localOffset + 26);
      const localExtraLength = u16(view, localOffset + 28);
      if (localMethod !== method || localFlags !== flags) throw new UnsafeZip("local/central mismatch");
      if (localOffset + 30 + localNameLength > bytes.byteLength) throw new UnsafeZip("local name out of bounds");
      if (!sameBytes(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength), nameBytes)) throw new UnsafeZip("local/central name mismatch");
      // Without a data descriptor the local sizes are real and must agree; with one they are 0
      // and the central sizes (used below) are the truth.
      if (!(flags & FLAG_DATA_DESCRIPTOR) && (u32(view, localOffset + 18) !== compressedSize || u32(view, localOffset + 22) !== uncompressedSize)) {
        throw new UnsafeZip("local/central size mismatch");
      }

      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > bytes.byteLength) throw new UnsafeZip("data out of bounds");
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);
      let data: Uint8Array;
      if (method === 0) {
        data = raw;
      } else {
        try {
          // +1 so an entry exactly at its declared size passes and anything larger throws.
          data = inflateRawSync(raw, { maxOutputLength: uncompressedSize + 1 });
        } catch {
          throw new UnsafeZip("inflate");
        }
      }
      if (data.byteLength !== uncompressedSize) throw new UnsafeZip("size mismatch");
      total += data.byteLength;
      entries.push({ nameBytes, data });
    }

    if (!REQUIRED_ENTRIES.every((name) => names.has(name))) return { ok: false, reason: "not_xlsx" };
    return { ok: true, zip: buildStoredZip(entries) };
  } catch (error) {
    if (error instanceof UnsafeZip || error instanceof RangeError || error instanceof TypeError) return { ok: false, reason: "unsafe" };
    throw error;
  }
}

import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder } from "@ammari/db/test-fixtures";
import { customerAddresses, orders, shippingAreas } from "@ammari/db/schema";
import { eq } from "drizzle-orm";
import {
  INDONESIAN_PROVINCES,
  formatShippingAddress,
  normalizeIndonesianPhone,
  parseShippingAddress,
  toShippingAddressSnapshot,
  type ShippingAddress,
  type ShippingAddressArea,
} from "./address";

// docs/plans/cart-checkout.md §4.5.1, session 8: address v2, the free fields plus the picked
// shipping_areas row (Biteship areas: kecamatan + kode pos, no kelurahan).

const area: ShippingAddressArea = {
  id: "7b0c7f4e-2f7e-4a4f-9a51-6b8c2b8f0a11",
  province: "Jawa Barat",
  city: "Kota Bandung",
  district: "Coblong",
  subdistrict: null,
  postalCode: "40132",
  providerAreaId: "IDNP9IDNC23IDND245IDZ40132",
};

const validInput = {
  recipientName: "  Siti   Aminah ",
  phone: "0812-3456-7890",
  addressLine: "Jl. Dago No. 10\nRT 01 RW 02, Kel. Dago",
  notes: "  ",
  // Ignored: the area has a kode pos.
  postalCode: "99999",
};

function parsedOrThrow(input: Record<string, unknown>, picked: ShippingAddressArea | null = area): ShippingAddress {
  const result = parseShippingAddress(input, picked);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe("normalizeIndonesianPhone", () => {
  test.each([
    ["081234567890", "+6281234567890"],
    ["0812-3456-7890", "+6281234567890"],
    ["0812 3456 7890", "+6281234567890"],
    ["+62 812 3456 7890", "+6281234567890"],
    ["6281234567890", "+6281234567890"],
    ["81234567890", "+6281234567890"],
    ["+62.812.3456.7890", "+6281234567890"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeIndonesianPhone(input)).toBe(expected);
  });

  test.each([
    [""],
    ["   "],
    ["0812"], // too short
    ["08123456789012345"], // too long
    ["+6208123456789"], // national number cannot start with 0 after the country code
    ["+1 415 555 0100"], // foreign number
    ["(022) 2501234"], // landline: not reachable on WhatsApp
    ["+62 22 2501234"],
    ["0812345"], // 7 national digits
    ["+62 8123 4567 8901 23"], // 14 national digits
    ["0812abc4567"],
    ["0812+34567890"],
  ])("rejects %j", (input) => {
    expect(normalizeIndonesianPhone(input)).toBeNull();
  });

  test("every accepted value matches the database phone CHECK", () => {
    // 8 and 13 national digits are the two boundaries.
    for (const input of ["081234567", "6281234567", "+62 8123 4567 8901 2"]) {
      const normalized = normalizeIndonesianPhone(input);
      expect(normalized).toMatch(/^\+62[0-9]{8,13}$/);
    }
  });
});

describe("INDONESIAN_PROVINCES", () => {
  test("lists all 38 provinces once", () => {
    expect(INDONESIAN_PROVINCES).toHaveLength(38);
    expect(new Set(INDONESIAN_PROVINCES.map((p) => p.toLowerCase())).size).toBe(38);
    expect(INDONESIAN_PROVINCES).toContain("Papua Barat Daya");
  });
});

describe("parseShippingAddress", () => {
  test("normalizes the free fields and takes the area from the loaded row", () => {
    expect(parsedOrThrow(validInput)).toEqual({
      recipientName: "Siti Aminah",
      phone: "+6281234567890",
      addressLine: "Jl. Dago No. 10 RT 01 RW 02, Kel. Dago",
      notes: null,
      shippingAreaId: area.id,
      providerAreaId: area.providerAreaId,
      province: "Jawa Barat",
      city: "Kota Bandung",
      district: "Coblong",
      subdistrict: null,
      postalCode: "40132",
    });
  });

  test("browser-sent area fields are never read", () => {
    const value = parsedOrThrow({ ...validInput, province: "Papua", city: "X", district: "Y", providerAreaId: "EVIL", shippingAreaId: "other" });
    expect(value).toMatchObject({ province: "Jawa Barat", city: "Kota Bandung", district: "Coblong", providerAreaId: area.providerAreaId, shippingAreaId: area.id });
  });

  test("keeps trimmed notes", () => {
    expect(parsedOrThrow({ ...validInput, notes: "  Pagar   hitam " }).notes).toBe("Pagar hitam");
  });

  test("a missing notes field is fine", () => {
    const { notes: _notes, ...withoutNotes } = validInput;
    expect(parsedOrThrow(withoutNotes).notes).toBeNull();
  });

  test("no area, or an area without a provider id, asks to pick one", () => {
    for (const picked of [null, { ...area, providerAreaId: null }]) {
      const result = parseShippingAddress(validInput, picked);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toEqual([{ field: "shippingAreaId", message: "Pilih kecamatan dari daftar." }]);
    }
  });

  test("an area without a kode pos requires the typed one", () => {
    const noPostal = { ...area, postalCode: null };
    expect(parsedOrThrow({ ...validInput, postalCode: " 401 35 " }, noPostal).postalCode).toBe("40135");
    const missing = parseShippingAddress({ ...validInput, postalCode: "" }, noPostal);
    expect(!missing.ok && missing.errors).toEqual([{ field: "postalCode", message: "Kode pos wajib diisi." }]);
    for (const bad of ["04013", "4013", "40132a"]) {
      const result = parseShippingAddress({ ...validInput, postalCode: bad }, noPostal);
      expect(!result.ok && result.errors).toEqual([{ field: "postalCode", message: "Kode pos harus 5 angka." }]);
    }
  });

  test("an area whose stored kode pos is malformed falls back to the typed one", () => {
    expect(parsedOrThrow({ ...validInput, postalCode: "40135" }, { ...area, postalCode: "0" }).postalCode).toBe("40135");
  });

  test("reports every invalid field at once, in form order", () => {
    const result = parseShippingAddress(
      { recipientName: " ", phone: "12", postalCode: "4013", addressLine: "Jl", notes: "a".repeat(201) },
      { ...area, postalCode: null },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual(["recipientName", "phone", "postalCode", "addressLine", "notes"]);

    const noArea = parseShippingAddress({ recipientName: " ", phone: "12", addressLine: "Jl" }, null);
    expect(!noArea.ok && noArea.errors.map((e) => e.field)).toEqual(["recipientName", "phone", "shippingAreaId", "addressLine"]);
  });

  test("rejects non-string and missing fields without throwing", () => {
    const result = parseShippingAddress({ recipientName: 42, phone: null }, area);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toContain("recipientName");
    expect(result.errors.map((e) => e.field)).toContain("addressLine");
  });

  test("rejects a non-object input", () => {
    expect(parseShippingAddress(null, area).ok).toBe(false);
    expect(parseShippingAddress("Jl. Dago", area).ok).toBe(false);
  });

  test("rejects over-long fields", () => {
    expect(parseShippingAddress({ ...validInput, recipientName: "a".repeat(101) }, area).ok).toBe(false);
    expect(parseShippingAddress({ ...validInput, addressLine: "a".repeat(501) }, area).ok).toBe(false);
  });

  test("strips control characters", () => {
    const value = parsedOrThrow({ ...validInput, addressLine: "Jl. Dago\u0000 No.\t10\r\n" });
    expect(value.addressLine).toBe("Jl. Dago No. 10");
  });

  test("a name of only zero-width characters counts as empty", () => {
    const result = parseShippingAddress({ ...validInput, recipientName: "\u200B\u200B\u200E\uFEFF" }, area);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ field: "recipientName", message: "Nama penerima wajib diisi." }]);
  });

  test("drops lone surrogates but keeps whole emoji", () => {
    const value = parsedOrThrow({ ...validInput, notes: "Rumah \uD83C\uDFE0 hijau \uD800" });
    expect(value.notes).toBe("Rumah \uD83C\uDFE0 hijau");
  });

  test("no error message uses an em dash", () => {
    const cases: Array<[Record<string, unknown>, ShippingAddressArea | null]> = [
      [{ recipientName: "", phone: "", postalCode: "", addressLine: "" }, { ...area, postalCode: null }],
      [{ ...validInput, recipientName: "a", addressLine: "Jl" }, null],
      [{ ...validInput, recipientName: "a".repeat(101), addressLine: "a".repeat(501), notes: "a".repeat(201), postalCode: "1" }, { ...area, postalCode: null }],
    ];
    for (const [input, picked] of cases) {
      const result = parseShippingAddress(input, picked);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      for (const error of result.errors) expect(error.message).not.toMatch(/\u2014/);
    }
  });
});

describe("formatShippingAddress", () => {
  test("renders one line with recipient, phone, address, area and notes", () => {
    const address = parsedOrThrow({ ...validInput, notes: "Pagar hitam" });
    expect(formatShippingAddress(address)).toBe(
      "Siti Aminah, +6281234567890, Jl. Dago No. 10 RT 01 RW 02, Kel. Dago, Coblong, Kota Bandung, Jawa Barat 40132. Catatan: Pagar hitam",
    );
  });

  test("omits the notes part when there are none, and adds a kelurahan when the area has one", () => {
    expect(formatShippingAddress(parsedOrThrow(validInput))).toBe(
      "Siti Aminah, +6281234567890, Jl. Dago No. 10 RT 01 RW 02, Kel. Dago, Coblong, Kota Bandung, Jawa Barat 40132",
    );
    expect(formatShippingAddress(parsedOrThrow(validInput, { ...area, subdistrict: "Dago" }))).toBe(
      "Siti Aminah, +6281234567890, Jl. Dago No. 10 RT 01 RW 02, Kel. Dago, Dago, Coblong, Kota Bandung, Jawa Barat 40132",
    );
  });
});

describe("toShippingAddressSnapshot", () => {
  test("is version 2 and carries the area ids", () => {
    const address = parsedOrThrow(validInput);
    expect(toShippingAddressSnapshot(address)).toEqual({ version: 2, ...address });
  });

  test("never copies extra keys, and they cannot override the version", () => {
    const address = parsedOrThrow(validInput);
    const savedRow = { ...address, id: "row-id", customerId: "customer-id", isDefault: true, version: 99 };
    expect(toShippingAddressSnapshot(savedRow)).toEqual({ version: 2, ...address });
  });
});

describe("parsed addresses satisfy the database constraints", () => {
  async function storedArea(tx: Parameters<Parameters<typeof withRollback>[0]>[0]): Promise<ShippingAddressArea> {
    const [row] = await tx
      .insert(shippingAreas)
      .values({ ...area, id: undefined, providerAreaId: `TEST${randomUUID()}`, searchText: "coblong", label: "Coblong, Kota Bandung, Jawa Barat 40132" })
      .returning();
    if (!row) throw new Error("failed to insert area");
    return row;
  }

  test("customer_addresses accepts a parsed address", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);
      const address = parsedOrThrow(validInput, await storedArea(tx));
      const [row] = await tx
        .insert(customerAddresses)
        .values({
          customerId: customer.id,
          recipientName: address.recipientName,
          phone: address.phone,
          addressLine: address.addressLine,
          shippingAreaId: address.shippingAreaId,
          province: address.province,
          city: address.city,
          district: address.district,
          subdistrict: address.subdistrict,
          postalCode: address.postalCode,
          notes: address.notes,
        })
        .returning();
      expect(row?.shippingAreaId).toBe(address.shippingAreaId);
    });
  });

  test("orders stores the snapshot and the text address", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const address = parsedOrThrow(validInput, await storedArea(tx));
      await tx
        .update(orders)
        .set({
          recipientName: address.recipientName,
          // The buyer's own contact number; the recipient's phone lives in the snapshot.
          contactPhone: "+6285700001111",
          shippingAddress: formatShippingAddress(address),
          shippingAddressSnapshot: toShippingAddressSnapshot(address),
          shippingAreaId: address.shippingAreaId,
        })
        .where(eq(orders.id, order.id));
      const [row] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(row?.shippingAddressSnapshot).toEqual(toShippingAddressSnapshot(address));
      expect(row?.shippingAddress).toContain("Jawa Barat 40132");
    });
  });
});

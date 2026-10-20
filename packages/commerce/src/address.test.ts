import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder } from "@ammari/db/test-fixtures";
import { customerAddresses, orders } from "@ammari/db/schema";
import { eq } from "drizzle-orm";
import {
  INDONESIAN_PROVINCES,
  formatShippingAddress,
  normalizeIndonesianPhone,
  parseShippingAddress,
  toShippingAddressSnapshot,
  type ShippingAddress,
} from "./address";

const validInput = {
  recipientName: "  Siti   Aminah ",
  phone: "0812-3456-7890",
  province: "jawa barat",
  city: " Kota Bandung ",
  district: "Coblong",
  postalCode: " 40132 ",
  addressLine: "Jl. Dago No. 10\nRT 01 RW 02",
  notes: "  ",
};

function parsedOrThrow(input: Record<string, unknown>): ShippingAddress {
  const result = parseShippingAddress(input);
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
  test("normalizes a valid address", () => {
    expect(parsedOrThrow(validInput)).toEqual({
      recipientName: "Siti Aminah",
      phone: "+6281234567890",
      province: "Jawa Barat",
      city: "Kota Bandung",
      district: "Coblong",
      postalCode: "40132",
      addressLine: "Jl. Dago No. 10 RT 01 RW 02",
      notes: null,
    });
  });

  test("keeps trimmed notes", () => {
    expect(parsedOrThrow({ ...validInput, notes: "  Pagar   hitam " }).notes).toBe("Pagar hitam");
  });

  test("a missing notes field is fine", () => {
    const { notes: _notes, ...withoutNotes } = validInput;
    expect(parsedOrThrow(withoutNotes).notes).toBeNull();
  });

  test("reports every invalid field at once, in form order", () => {
    const result = parseShippingAddress({
      recipientName: " ",
      phone: "12",
      province: "Atlantis",
      city: "",
      district: "x",
      postalCode: "4013",
      addressLine: "Jl",
      notes: "a".repeat(201),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual([
      "recipientName",
      "phone",
      "province",
      "city",
      "district",
      "postalCode",
      "addressLine",
      "notes",
    ]);
    for (const error of result.errors) {
      expect(error.message).not.toMatch(/—/); // no em dash in UI text
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  test("rejects non-string and missing fields without throwing", () => {
    const result = parseShippingAddress({ recipientName: 42, phone: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toContain("recipientName");
    expect(result.errors.map((e) => e.field)).toContain("addressLine");
  });

  test("rejects a non-object input", () => {
    expect(parseShippingAddress(null).ok).toBe(false);
    expect(parseShippingAddress("Jl. Dago").ok).toBe(false);
  });

  test("rejects postal codes outside 10000-99999", () => {
    expect(parseShippingAddress({ ...validInput, postalCode: "04013" }).ok).toBe(false);
    expect(parseShippingAddress({ ...validInput, postalCode: "40132a" }).ok).toBe(false);
  });

  test("rejects over-long fields", () => {
    expect(parseShippingAddress({ ...validInput, recipientName: "a".repeat(101) }).ok).toBe(false);
    expect(parseShippingAddress({ ...validInput, addressLine: "a".repeat(501) }).ok).toBe(false);
    expect(parseShippingAddress({ ...validInput, city: "a".repeat(101) }).ok).toBe(false);
  });

  test("strips control characters", () => {
    const value = parsedOrThrow({ ...validInput, addressLine: "Jl. Dago\u0000 No.\t10\r\n" });
    expect(value.addressLine).toBe("Jl. Dago No. 10");
  });

  test("a name of only zero-width characters counts as empty", () => {
    const result = parseShippingAddress({ ...validInput, recipientName: "\u200B\u200B\u200E\uFEFF" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ field: "recipientName", message: "Nama penerima wajib diisi." }]);
  });

  test("drops lone surrogates but keeps whole emoji", () => {
    const value = parsedOrThrow({ ...validInput, notes: "Rumah \uD83C\uDFE0 hijau \uD800" });
    expect(value.notes).toBe("Rumah \uD83C\uDFE0 hijau");
  });

  test("no error message uses an em dash", () => {
    const inputs = [
      { recipientName: "", phone: "", province: "", city: "", district: "", postalCode: "", addressLine: "" },
      { ...validInput, recipientName: "a", city: "a", district: "a", addressLine: "Jl" },
      { ...validInput, recipientName: "a".repeat(101), addressLine: "a".repeat(501), notes: "a".repeat(201) },
    ];
    for (const input of inputs) {
      const result = parseShippingAddress(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      for (const error of result.errors) expect(error.message).not.toMatch(/\u2014/);
    }
  });
});

describe("formatShippingAddress", () => {
  test("renders one line with recipient, phone, address and notes", () => {
    const address = parsedOrThrow({ ...validInput, notes: "Pagar hitam" });
    expect(formatShippingAddress(address)).toBe(
      "Siti Aminah, +6281234567890, Jl. Dago No. 10 RT 01 RW 02, Coblong, Kota Bandung, Jawa Barat 40132. Catatan: Pagar hitam",
    );
  });

  test("omits the notes part when there are none", () => {
    expect(formatShippingAddress(parsedOrThrow(validInput))).toBe(
      "Siti Aminah, +6281234567890, Jl. Dago No. 10 RT 01 RW 02, Coblong, Kota Bandung, Jawa Barat 40132",
    );
  });
});

describe("toShippingAddressSnapshot", () => {
  test("is versioned and records that no area row was used", () => {
    const address = parsedOrThrow(validInput);
    expect(toShippingAddressSnapshot(address)).toEqual({ version: 1, ...address, shippingAreaId: null });
  });

  test("never copies extra keys, and they cannot override the version", () => {
    const address = parsedOrThrow(validInput);
    const savedRow = { ...address, id: "row-id", customerId: "customer-id", isDefault: true, version: 99 };
    expect(toShippingAddressSnapshot(savedRow)).toEqual({ version: 1, ...address, shippingAreaId: null });
  });
});

describe("parsed addresses satisfy the database constraints", () => {
  test("customer_addresses accepts a parsed address", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);
      const address = parsedOrThrow(validInput);
      const [row] = await tx
        .insert(customerAddresses)
        .values({
          customerId: customer.id,
          recipientName: address.recipientName,
          phone: address.phone,
          addressLine: address.addressLine,
          province: address.province,
          city: address.city,
          district: address.district,
          postalCode: address.postalCode,
          notes: address.notes,
        })
        .returning();
      expect(row?.shippingAreaId).toBeNull();
    });
  });

  test("orders stores the snapshot and the text address", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const address = parsedOrThrow(validInput);
      await tx
        .update(orders)
        .set({
          recipientName: address.recipientName,
          // The buyer's own contact number; the recipient's phone lives in the snapshot.
          contactPhone: "+6285700001111",
          shippingAddress: formatShippingAddress(address),
          shippingAddressSnapshot: toShippingAddressSnapshot(address),
        })
        .where(eq(orders.id, order.id));
      const [row] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(row?.shippingAddressSnapshot).toEqual(toShippingAddressSnapshot(address));
      expect(row?.shippingAddress).toContain("Jawa Barat 40132");
    });
  });
});

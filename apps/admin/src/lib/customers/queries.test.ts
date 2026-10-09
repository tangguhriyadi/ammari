import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertCustomer } from "@ammari/db/test-fixtures";
import { createCustomer, searchCustomers } from "./queries";

describe("createCustomer", () => {
  test("creates a customer from just a name — no email, no PDP consent", async () => {
    await withRollback(async (tx) => {
      const customer = await createCustomer({ name: "Ibu Sari" }, tx);
      expect(customer.name).toBe("Ibu Sari");
      expect(customer.phone).toBeNull();
      expect(customer.email).toBeNull();
      expect(customer.pdpConsentAt).toBeNull();
    });
  });

  test("accepts an optional, validly-formatted phone", async () => {
    await withRollback(async (tx) => {
      const customer = await createCustomer({ name: "Pak Budi", phone: "+6281234567890" }, tx);
      expect(customer.phone).toBe("+6281234567890");
    });
  });

  test("rejects a malformed phone with a FieldError", async () => {
    await withRollback(async (tx) => {
      await expect(createCustomer({ name: "Pak Budi", phone: "0812345" }, tx)).rejects.toMatchObject({ field: "phone" });
    });
  });

  test("rejects a phone that collides with an existing customer", async () => {
    await withRollback(async (tx) => {
      await insertCustomer(tx, { phone: "+6281111111111", email: null, pdpConsentAt: null });
      await expect(createCustomer({ name: "Someone Else", phone: "+6281111111111" }, tx)).rejects.toMatchObject({ field: "phone" });
    });
  });
});

describe("searchCustomers", () => {
  test("finds a customer by partial name or phone, case-insensitively", async () => {
    await withRollback(async (tx) => {
      await createCustomer({ name: "Ibu Sari Wulandari", phone: "+6281234567890" }, tx);

      expect(await searchCustomers("sari wulan", tx)).toHaveLength(1);
      expect(await searchCustomers("81234567890", tx)).toHaveLength(1);
      expect(await searchCustomers("nobody-matches-this", tx)).toHaveLength(0);
    });
  });

  test("an empty/whitespace query returns no results rather than the whole table", async () => {
    await withRollback(async (tx) => {
      await createCustomer({ name: "Ibu Sari" }, tx);
      expect(await searchCustomers("   ", tx)).toEqual([]);
    });
  });
});

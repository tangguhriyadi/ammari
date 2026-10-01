import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { customers } from "../src/schema";
import { withRollback } from "./helpers";

describe("customers.phone", () => {
  test("two customers with no phone are both allowed", async () => {
    await withRollback(async (tx) => {
      await expect(
        tx.insert(customers).values([
          {
            phone: null,
            email: `customer-${randomUUID()}@example.test`,
            name: "No Phone One",
            pdpConsentAt: new Date(),
          },
          {
            phone: null,
            email: `customer-${randomUUID()}@example.test`,
            name: "No Phone Two",
            pdpConsentAt: new Date(),
          },
        ]),
      ).resolves.not.toThrow();
    });
  });

  test("two customers with the same non-null phone collide", async () => {
    await withRollback(async (tx) => {
      const phone = "+628123456789";
      await tx.insert(customers).values({
        phone,
        email: `customer-${randomUUID()}@example.test`,
        name: "First",
        pdpConsentAt: new Date(),
      });
      await expect(
        tx.insert(customers).values({
          phone,
          email: `customer-${randomUUID()}@example.test`,
          name: "Second",
          pdpConsentAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });

  test("a null phone still rejects a malformed non-null phone", async () => {
    await withRollback(async (tx) => {
      await expect(
        tx.insert(customers).values({
          phone: "08123456789", // missing +62 prefix
          email: `customer-${randomUUID()}@example.test`,
          name: "Bad Phone",
          pdpConsentAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertCustomer } from "@ammari/db/test-fixtures";
import { customerAddresses, shippingAreas } from "@ammari/db/schema";

// The checkout's saved address (owner request 2026-10-21): only the customer's own default row.

vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));
const { loadSavedCheckoutAddress } = await import("./queries");

describe("loadSavedCheckoutAddress", () => {
  test("the customer's default address with its area as the form picks it; nobody else's", async () => {
    await withRollback(async (tx) => {
      const owner = await insertCustomer(tx);
      const stranger = await insertCustomer(tx);
      const [area] = await tx
        .insert(shippingAreas)
        .values({ province: "Jawa Barat", city: "Kota Bandung", district: "Coblong", postalCode: "40132", searchText: "coblong", label: null, providerAreaId: `TEST${randomUUID()}` })
        .returning();
      await tx.insert(customerAddresses).values({
        customerId: owner.id,
        recipientName: "Siti Aminah",
        phone: "+6281234567890",
        addressLine: "Jl. Melati 5",
        shippingAreaId: area!.id,
        province: "Jawa Barat",
        city: "Kota Bandung",
        district: "Coblong",
        postalCode: "40132",
        notes: null,
        isDefault: true,
      });
      expect(await loadSavedCheckoutAddress(owner.id, tx)).toEqual({
        recipientName: "Siti Aminah",
        phone: "+6281234567890",
        addressLine: "Jl. Melati 5",
        notes: "",
        postalCode: "",
        area: { id: area!.id, label: "Coblong, Kota Bandung, Jawa Barat 40132", hasPostalCode: true },
      });
      expect(await loadSavedCheckoutAddress(stranger.id, tx)).toBeNull();
    });
  });
});

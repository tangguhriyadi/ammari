import { describe, expect, test } from "vitest";
import { normalizeIndonesianPhone } from "../address";
import { createBiteshipClient } from "./biteship";
import { createBiteshipOrdersClient } from "./biteship-orders";
import { ShipmentProviderError } from "./shipment-provider";
import { shipmentReferenceId } from "./shipment-rules";

// Opt-in contract test of the Order API against the REAL Biteship API with a TEST key
// (docs/plans/cart-checkout.md §13, §15 Phase K, K1). Skipped unless run by hand with both flags:
//   BITESHIP_CONTRACT_TEST=1 BITESHIP_ORDER_CONTRACT_TEST=1 BITESHIP_API_KEY=<your Biteship test key> \
//   BITESHIP_ORIGIN_AREA_ID=... BITESHIP_SHIPPER_NAME=... BITESHIP_SHIPPER_PHONE=... BITESHIP_SHIPPER_ADDRESS=... \
//     pnpm --filter @ammari/commerce exec vitest run src/shipping/biteship-orders.contract.test.ts
// Test-mode orders are simulated (no courier, no balance used); the one Maps search to find a
// destination is real data and billed (a few rupiah). It books one order with a `CT-` reference,
// re-sends the same reference (must answer duplicate with the same order id), reads it, cancels it
// and reads it again, printing what Biteship returns (waybill, routing code, price, statuses). The
// cancelled order it leaves behind can be the "cancelled" test order of the Order API activation
// form. It never writes to any database.

const enabled = process.env.BITESHIP_CONTRACT_TEST === "1" && process.env.BITESHIP_ORDER_CONTRACT_TEST === "1";
const apiKey = process.env.BITESHIP_API_KEY ?? "";
const baseUrl = process.env.BITESHIP_BASE_URL ?? "https://api.biteship.com";

describe.skipIf(!enabled)("Biteship Order API contract (opt-in, real API, test key only)", () => {
  test("book, duplicate reference, read, cancel", { timeout: 90_000 }, async () => {
    // A live key here would book a real pickup.
    expect(apiKey.startsWith("biteship_test.")).toBe(true);
    const originAreaId = process.env.BITESHIP_ORIGIN_AREA_ID ?? "";
    const shipperPhone = normalizeIndonesianPhone(process.env.BITESHIP_SHIPPER_PHONE ?? "");
    expect(originAreaId).not.toBe("");
    expect(shipperPhone).not.toBeNull();

    const destination = (await createBiteshipClient({ apiKey, baseUrl }).searchAreas("Pesanggrahan"))[0];
    expect(destination).toBeDefined();

    const orders = createBiteshipOrdersClient({ apiKey, baseUrl });
    const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const input = {
      referenceId: shipmentReferenceId("CT-", `ORD-${stamp}`, 1),
      origin: {
        name: process.env.BITESHIP_SHIPPER_NAME ?? "Ammari",
        phone: shipperPhone!,
        address: process.env.BITESHIP_SHIPPER_ADDRESS ?? "",
        areaId: originAreaId,
      },
      destination: {
        name: "Uji Kontrak",
        phone: "+6281200000002",
        address: "Jalan Uji Kontrak No. 1, Kelurahan Uji",
        areaId: destination!.providerAreaId,
        note: "Pesanan uji, jangan dikirim",
      },
      courierCode: "jne",
      serviceCode: "reg",
      item: { name: "Pakaian", value: 269_000, weightGrams: 900, quantity: 1 },
      orderNote: "Pesanan uji kontrak",
    };

    const created = await orders.createShipment(input);
    console.info("[contract] created", created);
    expect(created.referenceId).toBe(input.referenceId);

    const duplicate = await orders.createShipment(input).then(
      () => null,
      (error: unknown) => error,
    );
    console.info("[contract] duplicate", duplicate instanceof ShipmentProviderError ? duplicate.logFields() : duplicate, (duplicate as ShipmentProviderError | null)?.existingOrderId);
    expect(duplicate).toBeInstanceOf(ShipmentProviderError);
    expect((duplicate as ShipmentProviderError).reason).toBe("duplicate_reference");
    expect((duplicate as ShipmentProviderError).existingOrderId).toBe(created.providerOrderId);

    const read = await orders.getShipment(created.providerOrderId);
    console.info("[contract] read", read);

    const cancelled = await orders.cancelShipment(created.providerOrderId, { reasonCode: "others", reason: "Pesanan uji kontrak" });
    console.info("[contract] cancelled", cancelled);
    const after = await orders.getShipment(created.providerOrderId);
    console.info("[contract] after cancel", after);
    expect(after.status).toBe("cancelled");
  });
});

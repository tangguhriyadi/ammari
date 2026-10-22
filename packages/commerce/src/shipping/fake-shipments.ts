import { randomBytes } from "node:crypto";
import { FAKE_SHIPPING_AREAS } from "./fake";
import {
  ShipmentProviderError,
  type CancelShipmentInput,
  type CancelledShipment,
  type CreateShipmentInput,
  type ProviderShipment,
  type ShipmentHistoryEntry,
  type ShipmentProvider,
} from "./shipment-provider";
import { BITESHIP_CANCELLABLE_STATUSES, canonicalBiteshipStatus, normalizeBiteshipStatus, type BiteshipOrderStatus } from "./shipment-rules";

// FakeShipmentProvider (docs/plans/cart-checkout.md §13, §15 Phase K): an in-memory Biteship for
// unit tests and e2e, selected by SHIPPING_ORDER_PROVIDER=fake behind the e2e fixtures gate
// (./shipment-config.ts). Never calls anything. It behaves like the documented API where it
// matters to our code: a unique reference id (a repeat is refused as a duplicate naming the
// existing order), a waybill at once, cancel only before pickup, and a history entry per status.
// Test controls move an order along (`advance`), change its price (a re-weigh) or its waybill.
//
// Destinations from the fake rate areas (./fake.ts) pick the behaviour, so e2e can reach every
// path through the real admin UI:
// - "Kecamatan E2E Gangguan": the booking is made but its answer is "lost" once (unavailable with
//   outcomeUnknown); booking the same reference again then answers duplicate with the order id.
// - "Kecamatan E2E Tanpa Layanan": refused (FAKE_SHIPMENT_REFUSED_CODE).
// - anything else: booked at the fake area's quoted price for that service (Rp20.000 otherwise).

export const FAKE_SHIPMENT_REFUSED_CODE = 40099999;
const FAKE_LOST_ANSWER_AREA_ID = "E2EGANGGUAN40333";
const FAKE_REFUSED_AREA_ID = "E2ETANPALAYANAN40222";
const FAKE_DEFAULT_PRICE = 20_000;

const FAKE_NOTES: Partial<Record<BiteshipOrderStatus, string>> = {
  confirmed: "E2E: Pesanan dikonfirmasi, mencari kurir.",
  allocated: "E2E: Kurir sudah ditugaskan.",
  picking_up: "E2E: Kurir menuju lokasi penjemputan.",
  picked: "E2E: Paket sudah dijemput kurir.",
  in_transit: "E2E: Paket dalam perjalanan.",
  dropping_off: "E2E: Paket sedang diantar ke penerima.",
  delivered: "E2E: Paket sudah diterima.",
  cancelled: "E2E: Pengiriman dibatalkan.",
};

interface FakeOrder {
  shipment: ProviderShipment;
}

export interface FakeShipmentStore {
  byId: Map<string, FakeOrder>;
  byReference: Map<string, string>;
}

const STORE_KEY = Symbol.for("ammari.fakeShipmentStore");

/** One store per process (kept on globalThis so a dev-server module reload keeps it), shared by
 * every fake provider built from the env, like the fake payment gateway's answers. */
export function processFakeShipmentStore(): FakeShipmentStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: FakeShipmentStore };
  holder[STORE_KEY] ??= { byId: new Map(), byReference: new Map() };
  return holder[STORE_KEY];
}

export function createFakeShipmentStore(): FakeShipmentStore {
  return { byId: new Map(), byReference: new Map() };
}

export interface FakeShipmentControls {
  /** Moves an order to `status` (documented spelling), adding a history entry. */
  advance(providerOrderId: string, status: string, note?: string): ProviderShipment;
  /** A re-weigh: the price Ammari pays changes (Biteship's `order.price`). */
  setPrice(providerOrderId: string, price: number): ProviderShipment;
  /** The courier issued another waybill (Biteship's `order.waybill_id`). */
  setWaybill(providerOrderId: string, waybillId: string | null): ProviderShipment;
  get(providerOrderId: string): ProviderShipment | null;
}

export interface FakeShipmentProviderOptions {
  store?: FakeShipmentStore;
  now?: () => Date;
}

function quotedPrice(input: CreateShipmentInput): number {
  const area = FAKE_SHIPPING_AREAS.find((candidate) => candidate.providerAreaId === input.destination.areaId);
  if (!area || area.rates === "unavailable") return FAKE_DEFAULT_PRICE;
  const rate = area.rates.find((candidate) => candidate.courierCode === input.courierCode && candidate.serviceCode === input.serviceCode);
  return rate?.cost ?? FAKE_DEFAULT_PRICE;
}

function copy(shipment: ProviderShipment): ProviderShipment {
  return {
    ...shipment,
    driver: shipment.driver ? { ...shipment.driver } : null,
    history: shipment.history.map((entry) => ({ ...entry, occurredAt: new Date(entry.occurredAt) })),
  };
}

export function createFakeShipmentProvider(options: FakeShipmentProviderOptions = {}): ShipmentProvider & { controls: FakeShipmentControls } {
  const store = options.store ?? processFakeShipmentStore();
  const now = options.now ?? (() => new Date());

  function entry(status: BiteshipOrderStatus, note?: string): ShipmentHistoryEntry {
    return { providerStatus: status, status: normalizeBiteshipStatus(status), note: note ?? FAKE_NOTES[status] ?? `E2E: ${status}`, occurredAt: now() };
  }

  function find(providerOrderId: string): FakeOrder {
    const order = store.byId.get(providerOrderId);
    if (!order) throw new ShipmentProviderError("not_found", "fake shipment has no such order", { status: 404 });
    return order;
  }

  function setStatus(order: FakeOrder, status: BiteshipOrderStatus, note?: string): void {
    order.shipment.providerStatus = status;
    order.shipment.knownStatus = status;
    order.shipment.status = normalizeBiteshipStatus(status);
    order.shipment.history.push(entry(status, note));
  }

  const controls: FakeShipmentControls = {
    advance(providerOrderId, status, note) {
      const known = canonicalBiteshipStatus(status);
      if (!known) throw new RangeError(`unknown fake shipment status ${status}`);
      const order = find(providerOrderId);
      setStatus(order, known, note);
      if (known === "allocated" || known === "picking_up") {
        order.shipment.driver = { name: "Kurir E2E", phone: "081200000099", plateNumber: "D 0000 EE" };
      }
      return copy(order.shipment);
    },
    setPrice(providerOrderId, price) {
      if (!Number.isSafeInteger(price) || price < 0) throw new RangeError("fake price must be whole rupiah");
      const order = find(providerOrderId);
      order.shipment.price = price;
      return copy(order.shipment);
    },
    setWaybill(providerOrderId, waybillId) {
      const order = find(providerOrderId);
      order.shipment.waybillId = waybillId;
      return copy(order.shipment);
    },
    get(providerOrderId) {
      const order = store.byId.get(providerOrderId);
      return order ? copy(order.shipment) : null;
    },
  };

  return {
    name: "fake",
    controls,

    async createShipment(input: CreateShipmentInput): Promise<ProviderShipment> {
      const existingId = store.byReference.get(input.referenceId);
      if (existingId) {
        throw new ShipmentProviderError("duplicate_reference", "fake shipment reference already used", {
          status: 400,
          providerCode: 40002060,
          outcomeUnknown: true,
          existingOrderId: existingId,
        });
      }
      if (input.destination.areaId === FAKE_REFUSED_AREA_ID) {
        throw new ShipmentProviderError("refused", "fake shipment refused", { status: 400, providerCode: FAKE_SHIPMENT_REFUSED_CODE });
      }
      const providerOrderId = randomBytes(12).toString("hex");
      const order: FakeOrder = {
        shipment: {
          providerOrderId,
          referenceId: input.referenceId,
          providerStatus: null,
          knownStatus: null,
          status: null,
          waybillId: `E2E${randomBytes(5).readUIntBE(0, 5).toString().padStart(13, "0")}`,
          trackingId: randomBytes(12).toString("hex"),
          routingCode: null,
          courierCode: input.courierCode,
          serviceCode: input.serviceCode,
          price: quotedPrice(input),
          trackingLink: null,
          driver: null,
          history: [],
        },
      };
      setStatus(order, "confirmed");
      store.byId.set(providerOrderId, order);
      store.byReference.set(input.referenceId, providerOrderId);
      // Booked, but the answer never arrives (only the first time: the reference now exists).
      if (input.destination.areaId === FAKE_LOST_ANSWER_AREA_ID) {
        throw new ShipmentProviderError("unavailable", "fake shipment answer lost", { outcomeUnknown: true });
      }
      return copy(order.shipment);
    },

    async getShipment(providerOrderId: string): Promise<ProviderShipment> {
      const order = find(providerOrderId);
      // Like Biteship: the booking answer has no routing code, the order read does.
      order.shipment.routingCode ??= "E2E-01";
      return copy(order.shipment);
    },

    async cancelShipment(providerOrderId: string, _input: CancelShipmentInput): Promise<CancelledShipment> {
      const order = find(providerOrderId);
      const status = order.shipment.knownStatus;
      if (!status || !BITESHIP_CANCELLABLE_STATUSES.has(status)) {
        throw new ShipmentProviderError("not_cancellable", "fake shipment is past pickup", { status: 400, providerCode: 40002053 });
      }
      setStatus(order, "cancelled");
      return { providerOrderId, providerStatus: "cancelled" };
    },
  };
}

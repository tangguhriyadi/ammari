import { ShippingRateError, type RatesInput, type ShippingArea, type ShippingRateProvider } from "./provider";
import type { RatedService } from "./rules";

// FakeShippingRateProvider (docs/plans/cart-checkout.md §13, session 8): fictional areas with
// fixed quotes for unit tests and e2e, selected by SHIPPING_RATE_PROVIDER=fake behind the e2e
// fixtures gate (./config.ts). Never calls anything. Quotes ignore weight and value so e2e
// numbers stay stable. The names are fictional on purpose: no real city appears in our copy.

export const FAKE_ORIGIN_AREA_ID = "E2EORIGIN";

interface FakeArea extends ShippingArea {
  /** What quoteRates answers for this destination; "unavailable" throws like an outage. */
  rates: RatedService[] | "unavailable";
}

export const FAKE_SHIPPING_AREAS: readonly FakeArea[] = [
  {
    providerAreaId: "E2EMURAH40111",
    province: "Provinsi E2E",
    city: "Kota E2E",
    district: "Kecamatan E2E Murah",
    subdistrict: null,
    postalCode: "40111",
    // Rp12.000: fully covered by the subsidy, buyer pays Rp0.
    rates: [
      { courierCode: "jne", serviceCode: "reg", cost: 12_000 },
      { courierCode: "jnt", serviceCode: "ez", cost: 13_000 },
      { courierCode: "jne", serviceCode: "yes", cost: 9_000 },
    ],
  },
  {
    providerAreaId: "E2EJAUH99111",
    province: "Provinsi E2E Timur",
    city: "Kabupaten E2E",
    district: "Kecamatan E2E Jauh",
    subdistrict: null,
    postalCode: "99111",
    // Rp95.000: buyer pays Rp75.000.
    rates: [
      { courierCode: "pos", serviceCode: "kilat_khusus", cost: 95_000 },
      { courierCode: "sicepat", serviceCode: "reg", cost: 98_000 },
    ],
  },
  {
    providerAreaId: "E2ETANPALAYANAN40222",
    province: "Provinsi E2E",
    city: "Kota E2E",
    district: "Kecamatan E2E Tanpa Layanan",
    subdistrict: null,
    postalCode: "40222",
    // Only a non-allowlisted service: "no service".
    rates: [{ courierCode: "jne", serviceCode: "ctc", cost: 9_000 }],
  },
  {
    providerAreaId: "E2EGANGGUAN40333",
    province: "Provinsi E2E",
    city: "Kota E2E",
    district: "Kecamatan E2E Gangguan",
    subdistrict: null,
    postalCode: "40333",
    rates: "unavailable",
  },
  {
    providerAreaId: "E2ETANPAKODEPOS",
    province: "Provinsi E2E",
    city: "Kota E2E",
    district: "Kecamatan E2E Tanpa Kode Pos",
    subdistrict: null,
    postalCode: null,
    rates: [{ courierCode: "sicepat", serviceCode: "reg", cost: 15_000 }],
  },
];

/** A search text containing this word fails the search itself, like a provider outage. */
export const FAKE_SEARCH_FAILURE_WORD = "gagal";

function searchable(area: ShippingArea): string {
  return `${area.district} ${area.city} ${area.province} ${area.postalCode ?? ""}`.toLowerCase();
}

export function createFakeShippingRateProvider(areas: readonly FakeArea[] = FAKE_SHIPPING_AREAS): ShippingRateProvider {
  return {
    name: "fake",

    async searchAreas(query: string): Promise<ShippingArea[]> {
      const needle = query.trim().toLowerCase();
      if (needle.includes(FAKE_SEARCH_FAILURE_WORD)) throw new ShippingRateError("unavailable", "fake area search outage");
      return areas
        .filter((area) => searchable(area).includes(needle))
        .map(({ rates: _rates, ...area }) => area);
    },

    async quoteRates(input: RatesInput): Promise<RatedService[]> {
      const area = areas.find((candidate) => candidate.providerAreaId === input.destinationAreaId);
      if (!area) return [];
      if (area.rates === "unavailable") throw new ShippingRateError("unavailable", "fake rates outage");
      const couriers = new Set(input.courierCodes);
      return area.rates.filter((rate) => couriers.has(rate.courierCode));
    },
  };
}

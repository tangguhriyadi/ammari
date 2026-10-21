// Biteship response fixtures for unit tests, HAND-WRITTEN from the documented examples at
// https://biteship.com/id/docs (maps/search_area, rates/retrieve, rates/error, errors; read
// 2026-10-21), never recorded from a real call (plan §13). Test-only: not exported from the
// package.

/** From the Maps "search area" example (one district appears once per kode pos). */
export const BITESHIP_AREAS_OK = {
  success: true,
  areas: [
    {
      id: "IDNP6IDNC148IDND843IDZ12250",
      name: "Pesanggrahan, Jakarta Selatan, DKI Jakarta. 12250",
      country_name: "Indonesia",
      country_code: "ID",
      administrative_division_level_1_name: "DKI Jakarta",
      administrative_division_level_1_type: "province",
      administrative_division_level_2_name: "Jakarta Selatan",
      administrative_division_level_2_type: "city",
      administrative_division_level_3_name: "Pesanggrahan",
      administrative_division_level_3_type: "district",
      postal_code: 12250,
    },
    {
      id: "IDNP6IDNC148IDND843IDZ12260",
      name: "Pesanggrahan, Jakarta Selatan, DKI Jakarta. 12260",
      country_name: "Indonesia",
      country_code: "ID",
      administrative_division_level_1_name: "DKI Jakarta",
      administrative_division_level_1_type: "province",
      administrative_division_level_2_name: "Jakarta Selatan",
      administrative_division_level_2_type: "city",
      administrative_division_level_3_name: "Pesanggrahan",
      administrative_division_level_3_type: "district",
      postal_code: 12260,
    },
  ],
};

export const BITESHIP_AREAS_EMPTY = { success: true, areas: [] };

/** From the Rates example: the documented `sicepat`/`reg` entry verbatim, plus entries for other
 * allowlisted and non-allowlisted services in the same documented shape. */
export const BITESHIP_RATES_OK = {
  success: true,
  object: "courier_pricing",
  message: "Success to retrieve courier pricing",
  code: 20001007,
  pricing: [
    {
      available_collection_method: ["pickup"],
      available_for_cash_on_delivery: true,
      available_for_proof_of_delivery: false,
      available_for_instant_waybill_id: true,
      available_for_insurance: true,
      company: "sicepat",
      courier_name: "SiCepat",
      courier_code: "sicepat",
      courier_service_name: "Reguler",
      courier_service_code: "reg",
      currency: "IDR",
      description: "Layanan reguler",
      duration: "1 - 2 days",
      shipment_duration_range: "1 - 2",
      shipment_duration_unit: "days",
      service_type: "standard",
      shipping_type: "parcel",
      shipping_fee: 32000,
      shipping_fee_discount: 0,
      shipping_fee_surcharge: 0,
      insurance_fee: 1000,
      cash_on_delivery_fee: 2000,
      price: 35000,
      tax_lines: [],
      type: "reg",
    },
    { courier_code: "jne", courier_service_code: "reg", courier_name: "JNE", courier_service_name: "Reguler", price: 34000, type: "reg", duration: "2 - 3 days" },
    { courier_code: "jne", courier_service_code: "ctc", courier_name: "JNE", courier_service_name: "City Courier", price: 9000, type: "ctc", duration: "1 days" },
  ],
};

/** From the Rates error table: 40001010 "No courier available for requested location". */
export const BITESHIP_RATES_NO_COURIER = {
  success: false,
  error: "No courier available for requested location",
  code: 40001010,
};

/** From the general error format, with one of the documented authentication codes. */
export const BITESHIP_UNAUTHORIZED = {
  success: false,
  error: "Authentication failed",
  code: 40101001,
};

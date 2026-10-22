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

// Order API (Phase K, K1), hand-written from the documented fields of
// https://biteship.com/id/docs/api/orders/create, /retrieve, /delete and /error (read 2026-10-22).
// Ids, waybills and names are fictional.

/** `POST /v1/orders` success: status `confirmed`, waybill issued at once (`delivery_type: now`). */
export const BITESHIP_ORDER_CREATED = {
  success: true,
  message: "Order successfully created",
  object: "order",
  id: "5dd599ebdefcd4158eb8470b",
  reference_id: "DEV-ORD-202612-0001-K1",
  shipper: { name: "Ammari", email: null, phone: "081200000001", organization: "Ammari" },
  origin: { contact_name: "Ammari", contact_phone: "081200000001", address: "Jalan Contoh No. 1", note: null, postal_code: 40132 },
  destination: {
    contact_name: "Rina Contoh",
    contact_phone: "081200000002",
    contact_email: null,
    address: "Jalan Contoh No. 2, RT 01/RW 02, Kelurahan Contoh",
    note: "Pagar hitam",
    postal_code: 12250,
    cash_on_delivery: null,
    proof_of_delivery: { use: false, fee: 0, note: null, link: null },
  },
  courier: {
    tracking_id: "6051861741a37414e6637fab",
    waybill_id: "0123082100003094",
    company: "jne",
    type: "reg",
    link: null,
    insurance: { amount: 0, fee: 0, note: "" },
  },
  delivery: { datetime: "2026-12-02T10:00+07:00", note: null, type: "now", distance: 0, distance_unit: "kilometer" },
  items: [{ name: "Pakaian", description: null, sku: null, value: 538000, quantity: 1, length: null, width: null, height: null, weight: 1500 }],
  price: 34000,
  currency: "IDR",
  status: "confirmed",
  metadata: {},
};

/** `GET /v1/orders/:id` after pickup: routing code, driver and history (oldest first in the docs;
 * the client sorts anyway). */
export const BITESHIP_ORDER_PICKED = {
  ...BITESHIP_ORDER_CREATED,
  message: "Order retrieved",
  status: "picked",
  price: 41000,
  courier: {
    tracking_id: "6051861741a37414e6637fab",
    waybill_id: "0123082100003094",
    company: "jne",
    type: "reg",
    routing_code: "BDO-JKT 12250",
    shipment_fee: 41000,
    link: "https://track.example.invalid/0123082100003094",
    driver_name: "Budi Kurir",
    driver_phone: "081200000003",
    driver_photo_url: null,
    driver_plate_number: "D 1234 AB",
    history: [
      { service_type: "reg", status: "confirmed", note: "Order has been confirmed. Locating nearest driver to pick up.", updated_at: "2026-12-02T10:00:00+07:00" },
      { service_type: "reg", status: "allocated", note: "Courier has been allocated.", updated_at: "2026-12-02T11:30:00+07:00" },
      { service_type: "reg", status: "picked", note: "Item has been picked and ready to be shipped.", updated_at: "2026-12-02T14:05:00+07:00" },
    ],
  },
};

/** The orders error table's 40002060, with the existing order in `details`. */
export const BITESHIP_ORDER_DUPLICATE_REFERENCE = {
  success: false,
  error: "Reference id has already been used before. Please input other reference id",
  code: 40002060,
  details: { order_id: "5dd599ebdefcd4158eb8470b", waybill_id: "0123082100003094", reference_id: "DEV-ORD-202612-0001-K1" },
};

/** A validation refusal in the documented error format (insufficient balance). */
export const BITESHIP_ORDER_REFUSED = { success: false, error: "Your balance is not enough", code: 40002039 };

/** `POST /v1/orders/:id/cancel` success. */
export const BITESHIP_ORDER_CANCELLED = {
  success: true,
  message: "Order successfully deleted",
  object: "order",
  id: "5dd599ebdefcd4158eb8470b",
  status: "cancelled",
  cancellation_reason_code: "others",
  cancellation_reason: "Dibatalkan oleh admin",
};

/** 40002053: the order is past pickup. */
export const BITESHIP_ORDER_NOT_CANCELLABLE = {
  success: false,
  error: "Can't cancel order, order already has a status that blocks cancellation",
  code: 40002053,
};

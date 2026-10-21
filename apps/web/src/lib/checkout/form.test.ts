import { describe, expect, test } from "vitest";
import { computeCheckoutTotals, validateCheckoutForm, type CheckoutFormValues } from "./form";

// docs/plans/cart-checkout.md §4.3, §4.5.6, session 10: the browser-side form checks (the same
// messages placeOrder answers with) and the summary arithmetic.

function values(overrides: Partial<CheckoutFormValues> = {}): CheckoutFormValues {
  return {
    contactEmail: "siti@example.test",
    contactPhone: "0812 1111 2222",
    recipientName: "Siti Aminah",
    phone: "0812 3456 7890",
    addressLine: "Jl. Melati No. 5, Kel. Sukamaju",
    notes: "",
    postalCode: "",
    area: { id: "area-1", label: "Kecamatan A, Kota B, Provinsi C 40111", hasPostalCode: true },
    termsAccepted: true,
    ...overrides,
  };
}

describe("validateCheckoutForm", () => {
  test("a complete form passes", () => {
    expect(validateCheckoutForm(values(), { emailLocked: false })).toEqual([]);
  });

  test("an empty form lists every problem in form order with placeOrder's messages", () => {
    const issues = validateCheckoutForm(
      values({ contactEmail: "", contactPhone: "", recipientName: "", phone: "", addressLine: "", area: null, termsAccepted: false }),
      { emailLocked: false },
    );
    expect(issues).toEqual([
      { field: "contactEmail", message: "Email wajib diisi." },
      { field: "contactPhone", message: "Nomor WhatsApp wajib diisi." },
      { field: "recipientName", message: "Nama penerima wajib diisi." },
      { field: "phone", message: "Nomor HP penerima wajib diisi." },
      { field: "shippingAreaId", message: "Pilih kecamatan dari daftar." },
      { field: "addressLine", message: "Alamat lengkap wajib diisi." },
      { field: "termsAccepted", message: "Setujui Syarat & Ketentuan dan Kebijakan privasi untuk melanjutkan." },
    ]);
  });

  test("a locked (session) email is not checked; a landline and a bad email are refused", () => {
    expect(validateCheckoutForm(values({ contactEmail: "" }), { emailLocked: true })).toEqual([]);
    expect(validateCheckoutForm(values({ contactEmail: "siti@", contactPhone: "021 555 1234" }), { emailLocked: false })).toEqual([
      { field: "contactEmail", message: "Email tidak valid." },
      { field: "contactPhone", message: "Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890." },
    ]);
  });

  test("the kode pos is asked only when the area has none", () => {
    const noPostal = { id: "area-2", label: "Kecamatan Tanpa Kode Pos", hasPostalCode: false };
    expect(validateCheckoutForm(values({ area: noPostal }), { emailLocked: false })).toEqual([{ field: "postalCode", message: "Kode pos wajib diisi." }]);
    expect(validateCheckoutForm(values({ area: noPostal, postalCode: "4011" }), { emailLocked: false })).toEqual([
      { field: "postalCode", message: "Kode pos harus 5 angka." },
    ]);
    expect(validateCheckoutForm(values({ area: noPostal, postalCode: "40111" }), { emailLocked: false })).toEqual([]);
    expect(validateCheckoutForm(values({ postalCode: "x" }), { emailLocked: false })).toEqual([]);
  });
});

describe("computeCheckoutTotals", () => {
  test("ongkir is added once quoted; the voucher takes off goods only, never more than the subtotal", () => {
    expect(computeCheckoutTotals(250_000, null, null)).toEqual({ discount: 0, total: 250_000 });
    expect(computeCheckoutTotals(250_000, 75_000, null)).toEqual({ discount: 0, total: 325_000 });
    expect(computeCheckoutTotals(250_000, 75_000, 20_000)).toEqual({ discount: 20_000, total: 305_000 });
    expect(computeCheckoutTotals(15_000, 75_000, 20_000)).toEqual({ discount: 15_000, total: 75_000 });
    expect(computeCheckoutTotals(250_000, 0, 20_000)).toEqual({ discount: 20_000, total: 230_000 });
  });
});

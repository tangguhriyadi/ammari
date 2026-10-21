// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CART_COUNT_EVENT } from "@/lib/cart/count-event";
import { CheckoutForm, type CheckoutFormProps } from "./checkout-form";

// docs/plans/cart-checkout.md §4.3 to §4.5, session 10: the checkout form's own behaviour, with
// the server actions, the area search route and the navigation mocked. The server rules
// themselves are covered by the action and placeOrder tests.

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
const placeOrderAction = vi.fn();
vi.mock("@/lib/checkout/actions", () => ({ placeOrderAction: (input: unknown) => placeOrderAction(input) }));
const quoteShippingAction = vi.fn();
vi.mock("@/lib/checkout/quote-actions", () => ({ quoteShippingAction: (input: unknown) => quoteShippingAction(input) }));
vi.mock("@/app/checkout/actions", () => ({ signOutFromCheckoutAction: vi.fn() }));
const goToPaymentPage = vi.fn<(url: string) => boolean>(() => true);
vi.mock("@/lib/checkout/navigate", () => ({ goToPaymentPage: (url: string) => goToPaymentPage(url) }));

const ATTEMPT_ID = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
const JAUH = { id: "11111111-1111-4111-8111-111111111111", label: "Kecamatan E2E Jauh, Kabupaten E2E, Provinsi E2E Timur 99111", hasPostalCode: true };
const JAUH_QUOTE = {
  ok: true,
  quote: { label: "POS Kilat Khusus", costAmount: 95_000, subsidyAmount: 20_000, buyerAmount: 75_000 },
  subtotal: 250_000,
  cartKey: "SKU-1:1|250000",
};

function props(overrides: Partial<CheckoutFormProps> = {}): CheckoutFormProps {
  return {
    checkoutAttemptId: ATTEMPT_ID,
    cart: {
      lines: [{ sku: "SKU-1", name: "Gamis Haura", variant: "Beige · M", qty: 1, lineTotal: 250_000, imageUrl: null }],
      subtotal: 250_000,
      pieceCount: 1,
      canCheckout: true,
    },
    customer: null,
    vouchers: [],
    whatsappNumber: "6281234567890",
    ...overrides,
  };
}

beforeEach(() => {
  refresh.mockReset();
  placeOrderAction.mockReset();
  quoteShippingAction.mockReset();
  goToPaymentPage.mockReset();
  goToPaymentPage.mockReturnValue(true);
  push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ areas: [JAUH] }), { status: 200, headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pickJauh(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("combobox", { name: "Kecamatan atau kode pos" }), "jauh");
  const option = await screen.findByRole("option", { name: JAUH.label });
  fireEvent.mouseDown(option);
  await screen.findByTestId("picked-area");
}

async function fillGuest(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "siti@example.test");
  await user.type(screen.getByLabelText("Nomor WhatsApp"), "0812 1111 2222");
  await user.type(screen.getByLabelText("Nama penerima"), "Siti Aminah");
  await user.type(screen.getByLabelText("Nomor HP penerima"), "0812 3456 7890");
  await user.type(screen.getByLabelText("Alamat lengkap"), "Jl. Melati No. 5, Kel. Sukamaju");
}

describe("CheckoutForm", () => {
  test("an empty submit lists every problem in one alert and calls nothing", async () => {
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    await user.click(screen.getByRole("button", { name: "Bayar sekarang" }));
    const alert = await screen.findByTestId("checkout-alert");
    expect(alert).toHaveTextContent("Email wajib diisi.");
    expect(alert).toHaveTextContent("Pilih kecamatan dari daftar.");
    expect(alert).toHaveTextContent("Setujui Syarat & Ketentuan dan Kebijakan privasi untuk melanjutkan.");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(placeOrderAction).not.toHaveBeenCalled();
    expect(quoteShippingAction).not.toHaveBeenCalled();
  });

  test("picking an area quotes it by our id only and shows the buyer's share, the subsidy and the total", async () => {
    quoteShippingAction.mockResolvedValue(JAUH_QUOTE);
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    expect(screen.getByTestId("shipping-row")).toHaveTextContent("Pilih alamat dulu untuk menghitung ongkir.");
    expect(screen.getByTestId("summary-shipping")).toHaveTextContent("-");

    await pickJauh(user);
    expect(fetch).toHaveBeenCalledWith("/api/shipping/areas?q=jauh", expect.objectContaining({ cache: "no-store" }));
    expect(quoteShippingAction).toHaveBeenCalledWith({ shippingAreaId: JAUH.id });
    expect(await screen.findByTestId("shipping-buyer-amount")).toHaveTextContent("Rp75.000");
    expect(screen.getByTestId("shipping-subsidy-line")).toHaveTextContent("Ongkir Rp95.000, subsidi Ammari -Rp20.000.");
    expect(screen.getByTestId("summary-shipping")).toHaveTextContent("Rp75.000");
    expect(screen.getByTestId("summary-total")).toHaveTextContent("Rp325.000");
    expect(refresh).not.toHaveBeenCalled();
  });

  test("a quote made for another cart than the one shown is never displayed; the page re-reads instead", async () => {
    quoteShippingAction.mockResolvedValue({ ...JAUH_QUOTE, subtotal: 500_000, cartKey: "SKU-1:2|500000" });
    const user = userEvent.setup();
    const { rerender } = render(<CheckoutForm {...props()} />);
    await pickJauh(user);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByTestId("shipping-buyer-amount")).toBeNull();
    expect(screen.getByTestId("summary-shipping")).toHaveTextContent("-");

    // The re-read page brings the new cart: quoted again, and now it matches.
    quoteShippingAction.mockResolvedValue({ ...JAUH_QUOTE, subtotal: 500_000, cartKey: "SKU-1:2|500000" });
    rerender(
      <CheckoutForm
        {...props({ cart: { lines: [{ sku: "SKU-1", name: "Gamis Haura", variant: "Beige · M", qty: 2, lineTotal: 500_000, imageUrl: null }], subtotal: 500_000, pieceCount: 2, canCheckout: true } })}
      />,
    );
    expect(await screen.findByTestId("shipping-buyer-amount")).toHaveTextContent("Rp75.000");
    expect(quoteShippingAction).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("summary-total")).toHaveTextContent("Rp575.000");
  });

  test("a successful order sends the shown total, announces an empty cart and opens the payment page", async () => {
    quoteShippingAction.mockResolvedValue(JAUH_QUOTE);
    placeOrderAction.mockResolvedValue({ ok: true, orderNo: "ORD-202610-0001", redirectUrl: "http://localhost:3100/api/test/payments/ORD-202610-0001-1" });
    const counts: unknown[] = [];
    const listener = (event: Event) => counts.push((event as CustomEvent).detail);
    window.addEventListener(CART_COUNT_EVENT, listener);
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    await fillGuest(user);
    await pickJauh(user);
    await screen.findByTestId("shipping-buyer-amount");
    await user.click(screen.getByLabelText(/Saya setuju dengan/));
    await user.click(screen.getByRole("button", { name: "Bayar sekarang" }));

    await waitFor(() => expect(goToPaymentPage).toHaveBeenCalledWith("http://localhost:3100/api/test/payments/ORD-202610-0001-1"));
    expect(placeOrderAction).toHaveBeenCalledWith({
      checkoutAttemptId: ATTEMPT_ID,
      contact: { email: "siti@example.test", phone: "0812 1111 2222" },
      address: { recipientName: "Siti Aminah", phone: "0812 3456 7890", addressLine: "Jl. Melati No. 5, Kel. Sukamaju", notes: "", postalCode: undefined },
      shippingAreaId: JAUH.id,
      voucherId: null,
      termsAccepted: true,
      promoOptIn: false,
      expectedTotal: 325_000,
    });
    expect(counts).toEqual([{ pieceCount: 0 }]);
    expect(screen.getByRole("status")).toHaveTextContent("Membuka halaman pembayaran");
    window.removeEventListener(CART_COUNT_EVENT, listener);
  });

  test("without a payment page the buyer goes to the finish page", async () => {
    quoteShippingAction.mockResolvedValue(JAUH_QUOTE);
    placeOrderAction.mockResolvedValue({ ok: true, orderNo: "ORD-202610-0002", redirectUrl: null });
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    await fillGuest(user);
    await pickJauh(user);
    await screen.findByTestId("shipping-buyer-amount");
    await user.click(screen.getByLabelText(/Saya setuju dengan/));
    await user.click(screen.getByRole("button", { name: "Bayar sekarang" }));
    await waitFor(() => expect(goToPaymentPage).toHaveBeenCalledWith("/checkout/finish?order=ORD-202610-0002"));
  });

  test("a drift refusal shows the message, re-reads the page and quotes again", async () => {
    quoteShippingAction.mockResolvedValue(JAUH_QUOTE);
    placeOrderAction.mockResolvedValue({ ok: false, message: "Harga, ongkir atau voucher berubah. Cek ringkasan lagi.", fieldErrors: [] });
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    await fillGuest(user);
    await pickJauh(user);
    await screen.findByTestId("shipping-buyer-amount");
    await user.click(screen.getByLabelText(/Saya setuju dengan/));
    await user.click(screen.getByRole("button", { name: "Bayar sekarang" }));

    expect(await screen.findByTestId("checkout-alert")).toHaveTextContent("Harga, ongkir atau voucher berubah. Cek ringkasan lagi.");
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(quoteShippingAction).toHaveBeenCalledTimes(2));
    expect(goToPaymentPage).not.toHaveBeenCalled();
  });

  test("a lost answer says pressing again is safe (same attempt id)", async () => {
    quoteShippingAction.mockResolvedValue(JAUH_QUOTE);
    placeOrderAction.mockRejectedValue(new Error("Failed to fetch"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    await fillGuest(user);
    await pickJauh(user);
    await screen.findByTestId("shipping-buyer-amount");
    await user.click(screen.getByLabelText(/Saya setuju dengan/));
    await user.click(screen.getByRole("button", { name: "Bayar sekarang" }));
    expect(await screen.findByTestId("checkout-alert")).toHaveTextContent("Koneksi terputus sebelum ada jawaban. Tekan Bayar sekarang sekali lagi");
    log.mockRestore();
  });

  test("provider down: 'Coba lagi' quotes again, and paying is refused with the same message", async () => {
    quoteShippingAction.mockResolvedValue({ ok: false, kind: "retry", message: "Ongkir belum bisa dihitung. Coba lagi sebentar lagi." });
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    await fillGuest(user);
    await pickJauh(user);
    expect(await screen.findByTestId("shipping-error")).toHaveTextContent("Ongkir belum bisa dihitung. Coba lagi sebentar lagi.");
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(quoteShippingAction).toHaveBeenCalledTimes(2));

    await user.click(screen.getByLabelText(/Saya setuju dengan/));
    await user.click(screen.getByRole("button", { name: "Bayar sekarang" }));
    expect(await screen.findByTestId("checkout-alert")).toHaveTextContent("Ongkir belum bisa dihitung. Coba lagi sebentar lagi.");
    expect(placeOrderAction).not.toHaveBeenCalled();
  });

  test("no service: a WhatsApp link prefilled with the area, never a provider name", async () => {
    quoteShippingAction.mockResolvedValue({
      ok: false,
      kind: "no_service",
      message: "Pengiriman ke alamat ini belum tersedia lewat website. Hubungi kami lewat WhatsApp.",
    });
    const user = userEvent.setup();
    render(<CheckoutForm {...props()} />);
    await pickJauh(user);
    const link = await screen.findByRole("link", { name: "Hubungi via WhatsApp" });
    expect(link.getAttribute("href")).toBe(
      `https://wa.me/6281234567890?text=${encodeURIComponent(`Halo, saya mau pesan. Alamat pengiriman: ${JAUH.label}.`)}`,
    );
  });

  test("logged in: locked email, best voucher preselected, × clears it, the voucher id is sent", async () => {
    quoteShippingAction.mockResolvedValue(JAUH_QUOTE);
    placeOrderAction.mockResolvedValue({ ok: false, message: "Voucher tidak bisa dipakai.", fieldErrors: [{ field: "voucherId", message: "Voucher tidak bisa dipakai." }] });
    const user = userEvent.setup();
    render(
      <CheckoutForm
        {...props({
          customer: { email: "siti@example.test", phone: "+6281211112222", name: "Siti" },
          vouchers: [
            { id: "v-best", amount: 20_000, expiresOn: "1 Desember 2026" },
            { id: "v-later", amount: 20_000, expiresOn: "1 Januari 2027" },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("locked-email")).toHaveTextContent("siti@example.test");
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("Nomor WhatsApp")).toBeNull();
    expect(screen.queryByRole("link", { name: "Masuk untuk pakai voucher" })).toBeNull();
    expect(screen.getByLabelText("Voucher")).toHaveValue("v-best");
    expect(screen.getByTestId("summary-voucher")).toHaveTextContent("-Rp20.000");

    await user.click(screen.getByRole("button", { name: "Hapus voucher" }));
    expect(screen.getByLabelText("Voucher")).toHaveValue("");
    expect(screen.queryByTestId("summary-voucher")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Voucher"), "v-later");

    // The recipient fields start from the account.
    expect(screen.getByLabelText("Nama penerima")).toHaveValue("Siti");
    await user.type(screen.getByLabelText("Alamat lengkap"), "Jl. Melati No. 5, Kel. Sukamaju");
    await pickJauh(user);
    await screen.findByTestId("shipping-buyer-amount");
    expect(screen.getByTestId("summary-total")).toHaveTextContent("Rp305.000");
    await user.click(screen.getByLabelText(/Saya setuju dengan/));
    await user.click(screen.getByRole("button", { name: "Bayar sekarang" }));

    await waitFor(() => expect(placeOrderAction).toHaveBeenCalled());
    expect(placeOrderAction.mock.calls[0]![0]).toMatchObject({
      contact: { email: undefined, phone: "+6281211112222" },
      voucherId: "v-later",
      expectedTotal: 305_000,
    });
    const alert = await screen.findByTestId("checkout-alert");
    expect(within(alert).getAllByText("Voucher tidak bisa dipakai.").length).toBeGreaterThan(0);
  });

  test("an empty cart and a cart that cannot be checked out show their notices instead of the form", () => {
    const { unmount } = render(<CheckoutForm {...props({ cart: { lines: [], subtotal: 0, pieceCount: 0, canCheckout: false } })} />);
    expect(screen.getByText("Keranjangmu masih kosong.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bayar sekarang" })).toBeNull();
    unmount();
    render(<CheckoutForm {...props({ cart: { ...props().cart, canCheckout: false } })} />);
    expect(screen.getByRole("link", { name: "Kembali ke keranjang" })).toHaveAttribute("href", "/cart");
    expect(screen.queryByRole("button", { name: "Bayar sekarang" })).toBeNull();
  });
});

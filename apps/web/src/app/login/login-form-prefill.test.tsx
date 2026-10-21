// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LOGIN_PREFILL_STORAGE_KEY, storeLoginPrefill } from "@/lib/auth/login-prefill";

// docs/plans/cart-checkout.md §4.4, session 10: the finish page's "Masuk untuk melihat semua
// pesanan" hands the order's contact email to the login form through sessionStorage (never the
// URL); the form shows it, and it stays until a code is sent.

vi.mock("@/lib/auth/client", () => ({ authClient: { emailOtp: { sendVerificationOtp: vi.fn() }, signIn: { emailOtp: vi.fn(), social: vi.fn() } } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

test("the handed-over email fills the email field and stays until a code is sent", async () => {
  storeLoginPrefill("siti@example.test");
  const { LoginForm } = await import("./login-form");
  render(<LoginForm isGoogleConfigured={false} next="/account" />);
  expect(screen.getByLabelText("Email")).toHaveValue("siti@example.test");
  expect(window.sessionStorage.getItem(LOGIN_PREFILL_STORAGE_KEY)).not.toBeNull();
});

test("a stale or malformed handover is ignored", async () => {
  window.sessionStorage.setItem(LOGIN_PREFILL_STORAGE_KEY, JSON.stringify({ email: "siti@example.test", at: Date.now() - 11 * 60 * 1000 }));
  const { readLoginPrefill } = await import("@/lib/auth/login-prefill");
  expect(readLoginPrefill()).toBeNull();
  window.sessionStorage.setItem(LOGIN_PREFILL_STORAGE_KEY, JSON.stringify({ email: "<script>", at: Date.now() }));
  expect(readLoginPrefill()).toBeNull();
  window.sessionStorage.setItem(LOGIN_PREFILL_STORAGE_KEY, "not json");
  expect(readLoginPrefill()).toBeNull();
});

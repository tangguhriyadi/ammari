// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LoginForm } from "./login-form";

const sendVerificationOtp = vi.fn();
const signInEmailOtp = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/auth/client", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: (...args: unknown[]) => sendVerificationOtp(...args) },
    signIn: {
      emailOtp: (...args: unknown[]) => signInEmailOtp(...args),
      social: vi.fn(),
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

// This file deliberately does NOT test "a refresh restores the in-flight OTP session" — see
// apps/admin's own login-form.test.tsx for why (the module-level snapshot cache this relies on
// is only exercised once per test-file evaluation). e2e/login-otp.spec.ts covers it with a real
// browser refresh instead.

beforeEach(() => {
  vi.useFakeTimers();
  sendVerificationOtp.mockReset().mockResolvedValue({ error: undefined });
  signInEmailOtp.mockReset();
  push.mockReset();
  refresh.mockReset();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function sendCode(email: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Kirim kode" }));
  });
}

describe("LoginForm (web)", () => {
  test("submitting an email advances to the OTP step and shows the live expiry countdown", async () => {
    render(<LoginForm isGoogleConfigured={false} next="/" />);
    await sendCode("customer@example.test");

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: "customer@example.test", type: "sign-in" });
    expect(screen.getAllByText(/Kode telah dikirim ke/)[0]).toHaveTextContent("customer@example.test");
    expect(screen.getByText("Kode berlaku 5:00")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("Kode berlaku 4:59")).toBeInTheDocument();
  });

  test("the code expiring after 5 minutes shows the expired message and disables submit", async () => {
    render(<LoginForm isGoogleConfigured={false} next="/" />);
    await sendCode("customer@example.test");

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(screen.getByText("Kode sudah kedaluwarsa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Masuk" })).toBeDisabled();
  });

  test("Ganti email returns to the email step with the previous email prefilled and the OTP cleared", async () => {
    render(<LoginForm isGoogleConfigured={false} next="/" />);
    await sendCode("wrong@example.test");

    fireEvent.change(screen.getByLabelText("Kode (6 digit)"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Ganti email" }));

    const emailInput = screen.getByLabelText("Email") as HTMLInputElement;
    expect(emailInput.value).toBe("wrong@example.test");
    expect(screen.queryByLabelText("Kode (6 digit)")).not.toBeInTheDocument();

    await sendCode("correct@example.test");
    expect(sendVerificationOtp).toHaveBeenLastCalledWith({ email: "correct@example.test", type: "sign-in" });
    expect((screen.getByLabelText("Kode (6 digit)") as HTMLInputElement).value).toBe("");
  });

  test("resend stays disabled with a countdown before 60s, then becomes available", async () => {
    render(<LoginForm isGoogleConfigured={false} next="/" />);
    await sendCode("customer@example.test");

    const resendButton = () => screen.getByRole("button", { name: /Kirim ulang/ });
    expect(resendButton()).toHaveTextContent("Kirim ulang dalam 1:00");
    expect(resendButton()).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(resendButton()).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(resendButton()).toHaveTextContent("Kirim ulang kode");
    expect(resendButton()).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(resendButton());
    });
    expect(sendVerificationOtp).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Kode berlaku 5:00")).toBeInTheDocument();
  });

  test("a rate-limited (429) send shows the rate-limit message, not the generic one", async () => {
    sendVerificationOtp.mockResolvedValue({ error: { status: 429 } });
    render(<LoginForm isGoogleConfigured={false} next="/" />);
    await sendCode("customer@example.test");
    expect(screen.getByRole("alert")).toHaveTextContent("Terlalu banyak percobaan. Coba lagi nanti.");
  });

  test("hit-area: buttons meet the 44px minimum (min-h-11 = 44px)", async () => {
    render(<LoginForm isGoogleConfigured={false} next="/" />);
    await sendCode("customer@example.test");
    for (const name of ["Masuk", "Ganti email", /Kirim ulang/]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11");
    }
  });
});

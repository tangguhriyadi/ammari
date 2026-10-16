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

// This file deliberately does NOT test "a refresh restores the in-flight OTP session" —
// `getSnapshot`'s cache (see login-form.tsx's own comment) is computed once per module
// evaluation, which vitest reuses across every test in this file, so a later test's sessionStorage
// writes can never retroactively change what an EARLIER-cached snapshot saw. That guarantee is a
// real page refresh in a real browser, which is exactly what e2e/login-otp.spec.ts exercises
// instead — the right level for an across-reload property like this one.

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

describe("LoginForm (admin)", () => {
  test("submitting an email advances to the OTP step and shows the live expiry countdown", async () => {
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: "staff@example.test", type: "sign-in" });
    expect(screen.getAllByText(/Kode telah dikirim ke/)[0]).toHaveTextContent("staff@example.test");
    expect(screen.getByText("Kode berlaku 5:00")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("Kode berlaku 4:59")).toBeInTheDocument();
  });

  test("the code expiring after 5 minutes shows the expired message and disables submit", async () => {
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(screen.getByText("Kode sudah kedaluwarsa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Masuk" })).toBeDisabled();
  });

  test("Ganti email returns to the email step with the previous email prefilled and the OTP cleared", async () => {
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("wrong@example.test");

    fireEvent.change(screen.getByLabelText("Kode (6 digit)"), { target: { value: "123456" } });

    fireEvent.click(screen.getByRole("button", { name: "Ganti email" }));

    const emailInput = screen.getByLabelText("Email") as HTMLInputElement;
    expect(emailInput.value).toBe("wrong@example.test"); // prefilled, not blank
    expect(screen.queryByLabelText("Kode (6 digit)")).not.toBeInTheDocument(); // OTP step unmounted

    await sendCode("correct@example.test");
    expect(sendVerificationOtp).toHaveBeenLastCalledWith({ email: "correct@example.test", type: "sign-in" });
    // Advancing to the OTP step again starts a fresh, empty OTP input — never the old "123456".
    expect((screen.getByLabelText("Kode (6 digit)") as HTMLInputElement).value).toBe("");
  });

  test("resend stays disabled with a countdown before 60s, then becomes available", async () => {
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    const resendButton = () => screen.getByRole("button", { name: /Kirim ulang/ });
    expect(resendButton()).toHaveTextContent("Kirim ulang dalam 1:00");
    expect(resendButton()).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(resendButton()).toBeDisabled();
    expect(resendButton()).toHaveTextContent("Kirim ulang dalam 0:01");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(resendButton()).toHaveTextContent("Kirim ulang kode");
    expect(resendButton()).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(resendButton());
    });
    expect(sendVerificationOtp).toHaveBeenCalledTimes(2);
    // Resending restarts the 5-minute countdown from the new send, not from the original one.
    expect(screen.getByText("Kode berlaku 5:00")).toBeInTheDocument();
  });

  test("a rate-limited (429) send shows the rate-limit message, not the generic one", async () => {
    sendVerificationOtp.mockResolvedValue({ error: { status: 429 } });
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");
    expect(screen.getByRole("alert")).toHaveTextContent("Terlalu banyak percobaan. Coba lagi nanti.");
  });

  test("buttons meet the 44px minimum hit-area (h-12 = 48px)", async () => {
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");
    for (const name of ["Masuk", "Ganti email", /Kirim ulang/]) {
      expect(screen.getByRole("button", { name })).toHaveClass("h-12");
    }
  });
});

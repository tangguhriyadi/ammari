// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LoginForm } from "./login-form";

const sendVerificationOtp = vi.fn();
const signInEmailOtp = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
// Real implementations (packages/ui/test/otp-send-guard.test.ts covers the actual
// crypto/localStorage behavior) — mocked here purely to keep this file's fake-timer-driven tests
// deterministic and independent of real Web Crypto/localStorage timing, same reasoning
// `authClient` itself is mocked. Defaults to "no remembered attempt" (null), i.e. every send in
// this file's existing tests behaves exactly as it did before the OTP-cooldown fix; the
// dedicated describe block below overrides it to exercise the new `skippedResend` path.
const getRememberedOtpSendAttempt = vi.fn();
const rememberOtpSendAttempt = vi.fn();
const clearRememberedOtpSendAttempt = vi.fn();

vi.mock("@/lib/auth/client", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: (...args: unknown[]) => sendVerificationOtp(...args) },
    signIn: {
      emailOtp: (...args: unknown[]) => signInEmailOtp(...args),
      social: vi.fn(),
    },
  },
}));

vi.mock("@ammari/ui/lib", async () => {
  const actual = await vi.importActual<typeof import("@ammari/ui/lib")>("@ammari/ui/lib");
  return {
    ...actual,
    getRememberedOtpSendAttempt: (...args: unknown[]) => getRememberedOtpSendAttempt(...args),
    rememberOtpSendAttempt: (...args: unknown[]) => rememberOtpSendAttempt(...args),
    clearRememberedOtpSendAttempt: (...args: unknown[]) => clearRememberedOtpSendAttempt(...args),
  };
});

// The server-backed resend-state check (fetch("/api/otp-resend-state")) — see apps/web's own
// login-form.test.tsx for the full reasoning. Defaults to "no cooldown" so every existing test
// above behaves exactly as before this fix.
const fetchMock = vi.fn();

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
  getRememberedOtpSendAttempt.mockReset().mockResolvedValue(null);
  rememberOtpSendAttempt.mockReset().mockResolvedValue(undefined);
  clearRememberedOtpSendAttempt.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ cooldownRemainingSeconds: 0, hasActiveCode: false }),
  });
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mockResendState(
  state: { cooldownRemainingSeconds: number; hasActiveCode: boolean } | "network-error" | "rate-limited",
): void {
  if (state === "network-error") {
    fetchMock.mockRejectedValue(new Error("network error"));
    return;
  }
  if (state === "rate-limited") {
    // The server's own per-IP throttle on /api/otp-resend-state (see that route's own doc
    // comment) — a resolved-but-not-ok response, same shape a real 429 arrives as.
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: "rate_limited" }) });
    return;
  }
  fetchMock.mockResolvedValue({ ok: true, json: async () => state });
}

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

describe("LoginForm (admin) — resend-cooldown fix, Case A: the server reports an earlier code is still unexpired and unused", () => {
  test("shows 'Kode sebelumnya masih berlaku' and skips calling sendVerificationOtp, instead of pretending a new code went out", async () => {
    mockResendState({ cooldownRemainingSeconds: 50, hasActiveCode: true });

    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/otp-resend-state",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "staff@example.test" }) }),
    );
    expect(sendVerificationOtp).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Kode sebelumnya masih berlaku/)[0]).toHaveTextContent("staff@example.test");
    expect(screen.getByText("Kode berlaku 4:50")).toBeInTheDocument();
  });
});

describe("LoginForm (admin) — resend-cooldown fix, Case B: the server reports the earlier code is gone (consumed/expired/locked out)", () => {
  test("stays on the email step with a live countdown error instead of advancing to a code step with nothing to enter", async () => {
    mockResendState({ cooldownRemainingSeconds: 37, hasActiveCode: false });

    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    expect(sendVerificationOtp).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Kode (6 digit)")).not.toBeInTheDocument(); // never advanced to "sent"
    expect(screen.getByRole("alert")).toHaveTextContent("Kamu baru saja meminta kode. Coba lagi dalam 37 detik.");
    expect(screen.getByRole("button", { name: "Kirim kode" })).toBeDisabled();
  });

  test("the countdown ticks down live and the error clears once it reaches 0, re-enabling the button", async () => {
    mockResendState({ cooldownRemainingSeconds: 2, hasActiveCode: false });

    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");
    expect(screen.getByRole("alert")).toHaveTextContent("Coba lagi dalam 2 detik.");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Coba lagi dalam 1 detik.");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kirim kode" })).not.toBeDisabled();
  });

  test("once the cooldown clears, submitting again sends a real code", async () => {
    mockResendState({ cooldownRemainingSeconds: 1, hasActiveCode: false });
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    mockResendState({ cooldownRemainingSeconds: 0, hasActiveCode: false });
    await sendCode("staff@example.test");

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: "staff@example.test", type: "sign-in" });
    expect(screen.getAllByText(/Kode telah dikirim ke/)[0]).toBeInTheDocument();
  });
});

describe("LoginForm (admin) — resend-state check unreachable: falls back to this browser's own localStorage memory", () => {
  test("a remembered send within 60s is treated as Case A (fail open, not a hard block)", async () => {
    mockResendState("network-error");
    const rememberedAt = Date.now() - 10_000; // 10s ago — still well within the 60s cooldown
    getRememberedOtpSendAttempt.mockResolvedValue(rememberedAt);

    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    expect(sendVerificationOtp).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Kode sebelumnya masih berlaku/)[0]).toHaveTextContent("staff@example.test");
    expect(screen.getByText("Kode berlaku 4:50")).toBeInTheDocument();
  });

  test("a remembered send older than 60s (but still under 5 minutes) is NOT treated as still-cooling-down — a real send happens", async () => {
    mockResendState("network-error");
    getRememberedOtpSendAttempt.mockResolvedValue(Date.now() - 70_000); // 70s ago — cooldown over

    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: "staff@example.test", type: "sign-in" });
    expect(screen.getAllByText(/Kode telah dikirim ke/)[0]).toBeInTheDocument();
  });

  test("no remembered send at all: a real send happens (fail open all the way through)", async () => {
    mockResendState("network-error");

    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: "staff@example.test", type: "sign-in" });
  });

  test("the server's own per-IP rate limit (429) is treated the same as unreachable — no crash, falls back cleanly", async () => {
    mockResendState("rate-limited");

    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: "staff@example.test", type: "sign-in" });
    expect(screen.getAllByText(/Kode telah dikirim ke/)[0]).toBeInTheDocument();
    expect(screen.queryByText(/Terlalu banyak percobaan/)).not.toBeInTheDocument();
  });
});

describe("LoginForm (admin) — clears the localStorage OTP guard on success", () => {
  test("a successful sign-in clears the remembered send attempt for that email", async () => {
    render(<LoginForm isGoogleConfigured={false} />);
    await sendCode("staff@example.test");

    signInEmailOtp.mockResolvedValue({ error: undefined });
    fireEvent.change(screen.getByLabelText("Kode (6 digit)"), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Masuk" }));
    });

    expect(clearRememberedOtpSendAttempt).toHaveBeenCalledWith(expect.any(String), "staff@example.test");
  });
});

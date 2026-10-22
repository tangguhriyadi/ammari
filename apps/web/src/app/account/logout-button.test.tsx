// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CART_COUNT_EVENT, CART_COUNT_REFRESH_EVENT, type CartCountDetail } from "@/lib/cart/count-event";

// "Keluar" empties the header bag at once (owner feedback 2026-10-22); the logout itself clears the
// cart cookie on the server (lib/auth/sign-out.ts). A failed logout asks the header to re-read the
// real count instead of leaving it empty.

const logoutAction = vi.fn(async () => {});
const clearRememberedOtpSendAttempt = vi.fn(async () => {});
vi.mock("@/app/actions", () => ({ logoutAction: () => logoutAction() }));
vi.mock("@ammari/ui/lib", () => ({ clearRememberedOtpSendAttempt: (...args: unknown[]) => clearRememberedOtpSendAttempt(...(args as [])) }));

const { LogoutButton } = await import("./logout-button");

const events: string[] = [];
function record(event: Event) {
  events.push(event.type === CART_COUNT_EVENT ? `count:${(event as CustomEvent<CartCountDetail>).detail.pieceCount}` : "refresh");
}

afterEach(() => {
  window.removeEventListener(CART_COUNT_EVENT, record);
  window.removeEventListener(CART_COUNT_REFRESH_EVENT, record);
  events.length = 0;
  logoutAction.mockReset();
  clearRememberedOtpSendAttempt.mockClear();
});

function listen() {
  window.addEventListener(CART_COUNT_EVENT, record);
  window.addEventListener(CART_COUNT_REFRESH_EVENT, record);
}

describe("LogoutButton", () => {
  test("announces an empty cart, forgets the OTP send attempt and logs out", async () => {
    listen();
    render(<LogoutButton email="pembeli@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Keluar" }));
    await waitFor(() => expect(logoutAction).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["count:0"]);
    expect(clearRememberedOtpSendAttempt).toHaveBeenCalledWith("ammari-web-otp-last-send", "pembeli@example.com");
  });

  test("without an email: still announces and logs out", async () => {
    listen();
    render(<LogoutButton email={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Keluar" }));
    await waitFor(() => expect(logoutAction).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["count:0"]);
    expect(clearRememberedOtpSendAttempt).not.toHaveBeenCalled();
  });

  test("a failed logout asks the header to re-read the count", async () => {
    logoutAction.mockRejectedValueOnce(new Error("offline"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", onError);
    listen();
    render(<LogoutButton email={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Keluar" }));
    await waitFor(() => expect(events).toEqual(["count:0", "refresh"]));
    window.removeEventListener("error", onError);
    consoleError.mockRestore();
  });
});

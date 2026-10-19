// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, useToast } from "../src/components/Toast";

function Trigger({ message }: { message: string }) {
  const toast = useToast();
  return <button onClick={() => toast.success(message)}>go</button>;
}

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  test("renders inside an always-mounted role=status live region", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  test("shows the message, then auto-dismisses", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger message="Supplier berhasil disimpan" />
      </ToastProvider>,
    );
    await user.click(screen.getByText("go"));
    expect(screen.getByRole("status")).toHaveTextContent("Supplier berhasil disimpan");
    act(() => vi.advanceTimersByTime(4100));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  test("can be closed manually", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger message="Halo" />
      </ToastProvider>,
    );
    await user.click(screen.getByText("go"));
    await user.click(screen.getByRole("button", { name: "Tutup notifikasi" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  test("useToast outside a provider throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Trigger message="x" />)).toThrow(/ToastProvider/);
  });
});

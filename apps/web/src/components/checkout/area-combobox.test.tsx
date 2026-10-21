// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PickedArea } from "@/lib/checkout/form";
import { AreaCombobox } from "./area-combobox";

// docs/plans/cart-checkout.md §4.5.1, session 10: the "Kecamatan atau kode pos" combobox against
// a mocked GET /api/shipping/areas.

const A = { id: "a", label: "Kecamatan Satu, Kota E2E, Provinsi E2E 40111", hasPostalCode: true };
const B = { id: "b", label: "Kecamatan Dua, Kota E2E, Provinsi E2E 40112", hasPostalCode: false };

function Harness({ onPick }: { onPick: (area: PickedArea | null) => void }) {
  const [value, setValue] = useState<PickedArea | null>(null);
  return (
    <AreaCombobox
      id="area"
      value={value}
      onChange={(area) => {
        setValue(area);
        onPick(area);
      }}
    />
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn(async () => Response.json({ areas: [A, B] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function input() {
  return screen.getByRole("combobox", { name: "Kecamatan atau kode pos" });
}

async function typeAndWait(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe("AreaCombobox", () => {
  test("waits for 3 characters and a 300 ms pause, then searches once", async () => {
    render(<Harness onPick={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "ka" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: "kec" } });
    fireEvent.change(input(), { target: { value: "keca" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/shipping/areas?q=keca");
    expect(await screen.findAllByRole("option")).toHaveLength(2);
    expect(input()).toHaveAttribute("aria-expanded", "true");
  });

  test("a newer search aborts the one before it", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return Response.json({ areas: [A] });
    });
    render(<Harness onPick={vi.fn()} />);
    await typeAndWait("satu");
    await typeAndWait("satu k");
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  test("arrow keys and Enter pick an option; the chosen line shows with 'Ganti', which brings the search back", async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await typeAndWait("kecamatan");
    await screen.findAllByRole("option");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", "area-listbox-1");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(B);
    expect(screen.getByTestId("picked-area")).toHaveTextContent(B.label);
    await waitFor(() => expect(screen.getByRole("button", { name: /Ganti kecamatan/ })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: /Ganti kecamatan/ }));
    expect(onPick).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(input()).toHaveFocus());
    expect(input()).toHaveValue("");
  });

  test("the server's message for a refused search, a fallback for a failed call, and 'not found'", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Terlalu banyak pencarian. Coba lagi sebentar lagi." }, { status: 429 }));
    render(<Harness onPick={vi.fn()} />);
    await typeAndWait("kecamatan");
    expect(await screen.findByRole("status")).toHaveTextContent("Terlalu banyak pencarian. Coba lagi sebentar lagi.");

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await typeAndWait("kecamatan x");
    expect(await screen.findByRole("status")).toHaveTextContent("Pencarian alamat belum bisa dipakai. Coba lagi sebentar lagi.");
    log.mockRestore();

    fetchMock.mockResolvedValueOnce(Response.json({ areas: [] }));
    await typeAndWait("kecamatan y");
    expect(await screen.findByRole("status")).toHaveTextContent("Tidak ditemukan. Coba nama kecamatan lain atau kode pos.");
  });

  test("a malformed answer is never shown as options", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ areas: [{ id: 1, label: "x" }] }));
    render(<Harness onPick={vi.fn()} />);
    await typeAndWait("kecamatan");
    expect(await screen.findByRole("status")).toHaveTextContent("Pencarian alamat belum bisa dipakai.");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

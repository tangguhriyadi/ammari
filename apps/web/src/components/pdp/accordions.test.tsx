// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Accordions } from "./accordions";
import { OPEN_ACCORDION_EVENT, SIZE_CHART_HEADING_ID, SIZE_GUIDE_ACCORDION_ID, type OpenAccordionDetail } from "./size-guide";
import { endTransition } from "../../../test/transition-end";

const items = [
  { id: "deskripsi", title: "Deskripsi", content: <p>Isi deskripsi</p> },
  { id: SIZE_GUIDE_ACCORDION_ID, title: "Ukuran", content: <h3 id={SIZE_CHART_HEADING_ID} tabIndex={-1}>Panduan ukuran</h3> },
];

function requestSizeGuide() {
  const detail: OpenAccordionDetail = { accordionId: SIZE_GUIDE_ACCORDION_ID, targetId: SIZE_CHART_HEADING_ID };
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_ACCORDION_EVENT, { detail }));
  });
}

let scrollIntoView: ReturnType<typeof vi.fn>;
let scrollTo: ReturnType<typeof vi.fn>;
let reduceMotion = false;

beforeEach(() => {
  reduceMotion = false;
  scrollIntoView = vi.fn();
  scrollTo = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  window.matchMedia = ((query: string) => ({ matches: reduceMotion && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  window.location.hash = "";
});

describe("Accordions size guide request", () => {
  test("opens the closed Ukuran panel, then smooth-scrolls to and focuses the size chart heading", async () => {
    render(<Accordions items={items} />);
    expect(screen.getByRole("button", { name: "Ukuran" })).toHaveAttribute("aria-expanded", "false");

    requestSizeGuide();

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    // Measured with an instant jump, then reached with one smooth window scroll.
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: expect.any(Number), behavior: "smooth" });
    expect(screen.getByRole("button", { name: "Ukuran" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Deskripsi" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("heading", { name: "Panduan ukuran" })).toHaveFocus();
  });

  test("when the panel is already open it just scrolls and focuses", async () => {
    render(<Accordions items={items} />);
    requestSizeGuide();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    requestSizeGuide();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Ukuran" })).toHaveAttribute("aria-expanded", "true");
  });

  test("scrolls instantly under prefers-reduced-motion", async () => {
    reduceMotion = true;
    render(<Accordions items={items} />);
    requestSizeGuide();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

function panelOf(name: string) {
  return document.getElementById(screen.getByRole("button", { name }).getAttribute("aria-controls")!);
}

describe("Accordions curtain animation", () => {
  test("opening one panel unrolls it while the open one rolls up, then the closed one is removed", async () => {
    render(<Accordions items={items} />);
    act(() => screen.getByRole("button", { name: "Ukuran" }).click());

    expect(panelOf("Deskripsi")).toHaveAttribute("data-state", "closing");
    expect(screen.getByText("Isi deskripsi")).toBeInTheDocument();
    expect(panelOf("Ukuran")).toHaveAttribute("data-state", "entering");
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(panelOf("Ukuran")).toHaveAttribute("data-state", "opening");

    endTransition(panelOf("Deskripsi")!);
    endTransition(panelOf("Ukuran")!);
    expect(panelOf("Deskripsi")).toBeNull();
    expect(panelOf("Ukuran")).toHaveAttribute("data-state", "open");
  });

  test("the size guide scroll waits for the open animation to finish", async () => {
    render(<Accordions items={items} />);
    requestSizeGuide();
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(panelOf("Ukuran")).toHaveAttribute("data-state", "opening");
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(scrollIntoView).not.toHaveBeenCalled();

    endTransition(panelOf("Ukuran")!);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  test("prefers-reduced-motion: panels switch instantly", () => {
    reduceMotion = true;
    render(<Accordions items={items} />);
    act(() => screen.getByRole("button", { name: "Ukuran" }).click());
    expect(panelOf("Deskripsi")).toBeNull();
    expect(panelOf("Ukuran")).toHaveAttribute("data-state", "open");
  });

  test("a size guide request is dropped once the user closes the panel mid-open", async () => {
    render(<Accordions items={items} />);
    requestSizeGuide();
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    act(() => screen.getByRole("button", { name: "Ukuran" }).click());
    endTransition(panelOf("Ukuran")!);
    expect(panelOf("Ukuran")).toBeNull();

    // Reopening by hand later must not scroll or steal focus.
    act(() => screen.getByRole("button", { name: "Ukuran" }).click());
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    endTransition(panelOf("Ukuran")!);
    expect(panelOf("Ukuran")).toHaveAttribute("data-state", "open");
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  test("with Ukuran already open from the start, a request scrolls right away, every time", async () => {
    window.location.hash = "#ukuran";
    render(<Accordions items={[items[1]!, items[0]!]} />);
    expect(panelOf("Ukuran")).toHaveAttribute("data-state", "open");
    requestSizeGuide();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    requestSizeGuide();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
  });
});

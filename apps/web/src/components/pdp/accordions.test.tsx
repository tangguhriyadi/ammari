// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Accordions } from "./accordions";
import { OPEN_ACCORDION_EVENT, SIZE_CHART_HEADING_ID, SIZE_GUIDE_ACCORDION_ID, type OpenAccordionDetail } from "./size-guide";

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
let reduceMotion = false;

beforeEach(() => {
  reduceMotion = false;
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
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
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
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
  });
});

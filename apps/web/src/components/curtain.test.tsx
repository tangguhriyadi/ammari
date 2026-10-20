// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Curtain, CURTAIN_DURATION_MS } from "./curtain";
import { endTransition } from "../../test/transition-end";

let reduceMotion = false;

beforeEach(() => {
  reduceMotion = false;
  window.matchMedia = ((query: string) => ({ matches: reduceMotion && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
});

function panel() {
  return document.getElementById("panel");
}

function renderCurtain(open: boolean, onOpened = vi.fn()) {
  const view = render(
    <Curtain open={open} id="panel" onOpened={onOpened}>
      <button type="button">Isi</button>
    </Curtain>,
  );
  const setOpen = (next: boolean) =>
    view.rerender(
      <Curtain open={next} id="panel" onOpened={onOpened}>
        <button type="button">Isi</button>
      </Curtain>,
    );
  return { ...view, setOpen, onOpened };
}

async function nextFrame() {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

describe("Curtain", () => {
  test("renders nothing while closed and a settled panel when initially open", () => {
    const { unmount } = renderCurtain(false);
    expect(panel()).toBeNull();
    unmount();

    renderCurtain(true);
    expect(panel()).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("button", { name: "Isi" })).toBeInTheDocument();
  });

  test("opens from 0fr: entering, then opening on the next frame, then open after transitionend", async () => {
    const { setOpen, onOpened } = renderCurtain(false);
    setOpen(true);
    expect(panel()).toHaveAttribute("data-state", "entering");

    await nextFrame();
    expect(panel()).toHaveAttribute("data-state", "opening");
    expect(onOpened).not.toHaveBeenCalled();

    endTransition(panel()!);
    expect(panel()).toHaveAttribute("data-state", "open");
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  test("renders the closing state, inert, before removing the content", () => {
    const { setOpen } = renderCurtain(true);
    setOpen(false);

    expect(panel()).toHaveAttribute("data-state", "closing");
    expect(panel()).toHaveAttribute("inert");
    expect(screen.getByText("Isi")).toBeInTheDocument();

    endTransition(panel()!);
    expect(panel()).toBeNull();
  });

  test("ignores transitionend bubbling up from the content", () => {
    const { setOpen } = renderCurtain(true);
    setOpen(false);
    endTransition(screen.getByText("Isi"));
    expect(panel()).toHaveAttribute("data-state", "closing");
  });

  test("ignores the end of any other property's transition", () => {
    const { setOpen } = renderCurtain(true);
    endTransition(panel()!, "box-shadow");
    expect(panel()).toHaveAttribute("data-state", "open");
    setOpen(false);
    endTransition(panel()!, "opacity");
    expect(panel()).toHaveAttribute("data-state", "closing");
  });

  test("closing in the 0fr frame before unrolling removes it at once", () => {
    const { setOpen } = renderCurtain(false);
    setOpen(true);
    expect(panel()).toHaveAttribute("data-state", "entering");
    expect(panel()).toHaveAttribute("inert");
    setOpen(false);
    expect(panel()).toBeNull();
  });

  test("rapid toggling always ends in the state last asked for", async () => {
    const { setOpen, onOpened } = renderCurtain(false);
    setOpen(true);
    await nextFrame();
    setOpen(false);
    setOpen(true);
    setOpen(false);
    expect(panel()).toHaveAttribute("data-state", "closing");
    setOpen(true);
    expect(panel()).toHaveAttribute("data-state", "opening");
    endTransition(panel()!);
    expect(panel()).toHaveAttribute("data-state", "open");
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  test("settles on a timeout when transitionend never fires", () => {
    vi.useFakeTimers();
    const { setOpen } = renderCurtain(true);
    setOpen(false);
    act(() => vi.advanceTimersByTime(CURTAIN_DURATION_MS - 1));
    expect(panel()).toHaveAttribute("data-state", "closing");
    act(() => vi.advanceTimersByTime(200));
    expect(panel()).toBeNull();
  });

  test("reopening mid-close reverses straight into opening", () => {
    const { setOpen } = renderCurtain(true);
    setOpen(false);
    setOpen(true);
    expect(panel()).toHaveAttribute("data-state", "opening");
    expect(panel()).not.toHaveAttribute("inert");
  });

  test("prefers-reduced-motion: opens and closes instantly", () => {
    reduceMotion = true;
    const { setOpen, onOpened } = renderCurtain(false);
    setOpen(true);
    expect(panel()).toHaveAttribute("data-state", "open");
    expect(onOpened).toHaveBeenCalledTimes(1);

    setOpen(false);
    expect(panel()).toBeNull();
  });
});

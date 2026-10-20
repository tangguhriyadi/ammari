// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MobileNav } from "./mobile-nav";
import { endTransition } from "../../test/transition-end";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

let reduceMotion = false;

beforeEach(() => {
  pathname = "/";
  reduceMotion = false;
  window.matchMedia = ((query: string) => ({ matches: reduceMotion && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

function panel() {
  const id = document.querySelector("button[aria-controls]")!.getAttribute("aria-controls")!;
  return document.getElementById(id);
}

async function nextFrame() {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Buka menu" }));
  await nextFrame();
  endTransition(panel()!);
  expect(panel()).toHaveAttribute("data-state", "open");
  return user;
}

/** The close must be visible as a rendered closing state before the panel is removed. */
function expectClosingThenRemoved() {
  expect(screen.getByRole("button", { name: "Buka menu" })).toHaveAttribute("aria-expanded", "false");
  expect(panel()).toHaveAttribute("data-state", "closing");
  expect(screen.getByRole("navigation", { hidden: true })).toBeInTheDocument();
  endTransition(panel()!);
  expect(panel()).toBeNull();
}

describe("MobileNav", () => {
  test("the toggle unrolls the menu (entering, opening, open) and rolls it back up", async () => {
    const user = userEvent.setup();
    render(<MobileNav />);
    expect(panel()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Buka menu" }));
    const toggle = screen.getByRole("button", { name: "Tutup menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel()).toHaveAttribute("data-state", "entering");
    await nextFrame();
    expect(panel()).toHaveAttribute("data-state", "opening");
    endTransition(panel()!);
    expect(panel()).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("navigation", { name: "Navigasi utama" }).querySelectorAll("a")).toHaveLength(4);

    await user.click(toggle);
    expectClosingThenRemoved();
  });

  test("Escape closes with the animation and returns focus to the toggle", async () => {
    render(<MobileNav />);
    const user = await openMenu();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Buka menu" })).toHaveFocus();
    expectClosingThenRemoved();
  });

  test("a link inside the menu closes it with the animation", async () => {
    render(<MobileNav />);
    await openMenu();
    // Cancel jsdom's own navigation after React's handlers ran: only the close is under test.
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("click", preventNavigation);
    fireEvent.click(screen.getByRole("link", { name: "Akun" }));
    document.removeEventListener("click", preventNavigation);
    expectClosingThenRemoved();
  });

  test("a route change closes the menu", async () => {
    const { rerender } = render(<MobileNav />);
    await openMenu();
    pathname = "/account";
    rerender(<MobileNav />);
    expectClosingThenRemoved();
  });

  test("prefers-reduced-motion: opens and closes instantly", async () => {
    reduceMotion = true;
    const user = userEvent.setup();
    render(<MobileNav />);
    await user.click(screen.getByRole("button", { name: "Buka menu" }));
    expect(panel()).toHaveAttribute("data-state", "open");
    await user.click(screen.getByRole("button", { name: "Tutup menu" }));
    expect(panel()).toBeNull();
  });
});

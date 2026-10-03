// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { Switch } from "../src/components/Switch";

describe("Switch", () => {
  test("renders as a switch with the correct role and aria-checked", () => {
    render(<Switch checked={false} label="Aktif" />);
    const el = screen.getByRole("switch", { name: "Aktif" });
    expect(el).toHaveAttribute("aria-checked", "false");
  });

  test("aria-checked reflects checked=true", () => {
    render(<Switch checked label="Aktif" />);
    expect(screen.getByRole("switch", { name: "Aktif" })).toHaveAttribute("aria-checked", "true");
  });

  test("clicking calls onCheckedChange with the toggled value", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} label="Aktif" onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole("switch", { name: "Aktif" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  test("Space key toggles the switch", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} label="Aktif" onCheckedChange={onCheckedChange} />);
    screen.getByRole("switch", { name: "Aktif" }).focus();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  test("Enter key toggles the switch", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} label="Aktif" onCheckedChange={onCheckedChange} />);
    screen.getByRole("switch", { name: "Aktif" }).focus();
    await user.keyboard("{Enter}");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  test("disabled switch does not call onCheckedChange when clicked", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} label="Aktif" onCheckedChange={onCheckedChange} disabled />);
    const el = screen.getByRole("switch", { name: "Aktif" });
    expect(el).toHaveAttribute("aria-disabled", "true");
    await user.click(el);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  test("pending switch is marked aria-busy and aria-disabled, and does not call onCheckedChange", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} label="Aktif" onCheckedChange={onCheckedChange} pending />);
    const el = screen.getByRole("switch", { name: "Aktif" });
    expect(el).toHaveAttribute("aria-busy", "true");
    expect(el).toHaveAttribute("aria-disabled", "true");
    await user.click(el);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  test("pending switch stays focusable (not natively disabled) — focus must not jump to <body>", () => {
    // Regression test: a switch commonly becomes `pending` the instant the user activates it,
    // while it still has focus. Native `disabled` would forcibly blur a focused element right
    // then, dropping a keyboard/screen-reader user's focus to <body>. `aria-disabled` keeps the
    // element focusable while still blocking the action (see the click-is-blocked tests above).
    render(<Switch checked={false} label="Aktif" pending />);
    const el = screen.getByRole("switch", { name: "Aktif" });
    expect(el).not.toBeDisabled();
    el.focus();
    expect(el).toHaveFocus();
  });

  test("Space key does not toggle a pending switch", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} label="Aktif" onCheckedChange={onCheckedChange} pending />);
    screen.getByRole("switch", { name: "Aktif" }).focus();
    await user.keyboard(" ");
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  test("renders a hidden input carrying the value when name is set", () => {
    const { container } = render(<Switch checked label="Aktif" name="isActive" />);
    const hidden = container.querySelector('input[type="hidden"][name="isActive"]');
    expect(hidden).toHaveValue("true");
  });

  test("renders no hidden input when name is not set", () => {
    const { container } = render(<Switch checked label="Aktif" />);
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  test("shows the field error, associated via aria-describedby", () => {
    render(<Switch checked={false} label="Aktif" error="Gagal menyimpan." />);
    const el = screen.getByRole("switch", { name: "Aktif" });
    const describedBy = el.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent("Gagal menyimpan.");
  });

  test("accessibleLabel overrides the accessible name without changing the visible text", () => {
    render(<Switch checked={false} label="Aktif" accessibleLabel="Aktif untuk ukuran S" />);
    expect(screen.getByRole("switch", { name: "Aktif untuk ukuran S" })).toBeInTheDocument();
    expect(screen.getByText("Aktif", { exact: true })).toBeVisible();
  });
});

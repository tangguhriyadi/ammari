// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@ammari/ui";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ProductStepper, useStepSection, type ProductStepperProps } from "./product-stepper";

const ID = "6f1c2b9e-0000-4000-8000-000000000001";

beforeAll(() => {
  // jsdom's <dialog> has no modal support; the Dialog component only needs `open` to flip.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  push.mockReset();
});

function FakeSection({ dirty, save }: { dirty: boolean; save: () => Promise<boolean> }) {
  useStepSection(dirty, save);
  return <p>isi langkah</p>;
}

// Omit over each member of the create/edit union, not the union as a whole.
type StepperTestProps = ProductStepperProps extends infer P ? (P extends unknown ? Omit<P, "children"> : never) : never;

function renderStepper(props: StepperTestProps, section?: { dirty: boolean; save: () => Promise<boolean> }) {
  return render(
    <ToastProvider>
      <ProductStepper {...(props as ProductStepperProps)}>{section ? <FakeSection {...section} /> : <p>isi langkah</p>}</ProductStepper>
    </ToastProvider>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "Langkah produk" });

describe("step indicator", () => {
  it("before the product exists: step 1 is current, every other step is locked and not a link", () => {
    renderStepper({ mode: "create", productId: null, current: "info", reached: "info", hasVariants: false });
    const current = within(nav()).getByText("Info produk").closest("[aria-current]");
    expect(current).toHaveAttribute("aria-current", "step");
    expect(within(nav()).queryAllByRole("link")).toHaveLength(0);
    expect(within(nav()).getAllByText("(terkunci, selesaikan langkah sebelumnya dulu)")).toHaveLength(4);
    expect(screen.getByTestId("step-position")).toHaveTextContent("Langkah 1 dari 5 · Info produk");
    // No footer before the product exists: the form's own "Lanjut" creates it.
    expect(screen.queryByTestId("product-step-footer")).toBeNull();
  });

  it("create mode: done steps are links marked done, reachable steps are links, later steps are locked", () => {
    renderStepper({ mode: "create", productId: ID, current: "varian", reached: "foto", hasVariants: true });
    const links = within(nav()).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/products/${ID}/setup?step=info&reached=foto`,
      `/products/${ID}/setup?step=foto&reached=foto`,
    ]);
    expect(links[0]).toHaveAccessibleName(/Info produk.*selesai/);
    expect(screen.getByTestId("step-toko")).toHaveAttribute("data-locked");
    expect(screen.getByTestId("step-aksesoris")).toHaveAttribute("data-locked");
    // The page-wide unsaved-changes guard leaves the stepper's own links alone.
    for (const link of links) expect(link).toHaveAttribute("data-skip-unsaved-guard");
  });

  it("edit mode: every other step is a link; done marks follow the product's data", () => {
    renderStepper({
      mode: "edit",
      productId: ID,
      current: "info",
      hasVariants: true,
      completion: { hasVariants: true, hasPhotos: false, isPublished: false, hasRecipe: false },
    });
    expect(within(nav()).getAllByRole("link")).toHaveLength(4);
    expect(screen.getByTestId("step-varian")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("step-foto")).toHaveAttribute("data-status", "upcoming");
  });
});

describe("moving between steps", () => {
  it("clicking a step with nothing unsaved navigates straight away", () => {
    renderStepper({ mode: "create", productId: ID, current: "foto", reached: "foto", hasVariants: true }, { dirty: false, save: vi.fn() });
    fireEvent.click(within(nav()).getByRole("link", { name: /Varian/ }));
    expect(push).toHaveBeenCalledWith(`/products/${ID}/setup?step=varian&reached=foto`);
  });

  it("with unsaved changes, asks in a dialog first; Tetap di sini stays, Buang perubahan moves on", async () => {
    renderStepper(
      { mode: "edit", productId: ID, current: "info", hasVariants: true, completion: { hasVariants: true, hasPhotos: true, isPublished: true, hasRecipe: true } },
      { dirty: true, save: vi.fn() },
    );
    fireEvent.click(within(nav()).getByRole("link", { name: /Foto/ }));
    expect(push).not.toHaveBeenCalled();
    expect(await screen.findByText("Ada perubahan yang belum disimpan")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Tetap di sini" }));
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(within(nav()).getByRole("link", { name: /Foto/ }));
    fireEvent.click(screen.getByRole("button", { name: "Buang perubahan" }));
    expect(push).toHaveBeenCalledWith(`/products/${ID}?step=foto`);
  });

  it("edit mode: Lanjut only moves on (no save) and there is no Lewati", () => {
    const save = vi.fn();
    renderStepper(
      { mode: "edit", productId: ID, current: "varian", hasVariants: true, completion: { hasVariants: true, hasPhotos: true, isPublished: true, hasRecipe: true } },
      { dirty: false, save },
    );
    expect(screen.queryByRole("button", { name: "Lewati" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(save).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(`/products/${ID}?step=foto`);
  });
});

describe("create mode footer", () => {
  it("Lanjut saves the step first, then opens the next step with `reached` raised", async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderStepper({ mode: "create", productId: ID, current: "foto", reached: "foto", hasVariants: true }, { dirty: true, save });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/products/${ID}/setup?step=toko&reached=toko`));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a failed save keeps the owner on the step", async () => {
    const save = vi.fn().mockResolvedValue(false);
    renderStepper({ mode: "create", productId: ID, current: "toko", reached: "toko", hasVariants: true }, { dirty: true, save });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it("Varian needs at least one variant", async () => {
    renderStepper({ mode: "create", productId: ID, current: "varian", reached: "varian", hasVariants: false }, { dirty: false, save: vi.fn() });
    expect(screen.queryByRole("button", { name: "Lewati" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tambah minimal satu varian sebelum lanjut.");
    expect(push).not.toHaveBeenCalled();
  });

  it("Varian moves on when Lanjut itself added the first variants", async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderStepper({ mode: "create", productId: ID, current: "varian", reached: "varian", hasVariants: false }, { dirty: true, save });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/products/${ID}/setup?step=foto&reached=foto`));
  });

  it("Lewati moves on without saving; Kembali goes back keeping `reached`", () => {
    const save = vi.fn();
    renderStepper({ mode: "create", productId: ID, current: "foto", reached: "toko", hasVariants: true }, { dirty: false, save });
    fireEvent.click(screen.getByRole("button", { name: "Lewati" }));
    expect(push).toHaveBeenLastCalledWith(`/products/${ID}/setup?step=toko&reached=toko`);
    fireEvent.click(screen.getByRole("button", { name: "Kembali" }));
    expect(push).toHaveBeenLastCalledWith(`/products/${ID}/setup?step=varian&reached=toko`);
    expect(save).not.toHaveBeenCalled();
  });

  it("the last step's Selesai saves and opens the product's edit page", async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderStepper({ mode: "create", productId: ID, current: "aksesoris", reached: "aksesoris", hasVariants: true }, { dirty: true, save });
    expect(screen.getByRole("button", { name: "Lewati" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Selesai" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/products/${ID}`));
    expect(save).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildStepItems,
  isProductStepKey,
  productStepHref,
  resolveCreateStep,
  resolveEditStep,
  stepPositionLabel,
  type ProductStepCompletion,
} from "./stepper";

const ID = "6f1c2b9e-0000-4000-8000-000000000001";
const NOTHING: ProductStepCompletion = { hasVariants: false, hasPhotos: false, isPublished: false, hasRecipe: false };

describe("isProductStepKey", () => {
  it("accepts the five keys only", () => {
    for (const key of ["info", "varian", "foto", "toko", "aksesoris"]) expect(isProductStepKey(key)).toBe(true);
    for (const value of ["", "photos", "FOTO", undefined, 3]) expect(isProductStepKey(value)).toBe(false);
  });
});

describe("resolveEditStep", () => {
  it("opens the requested step", () => {
    expect(resolveEditStep("foto", { canManageProducts: true })).toBe("foto");
    expect(resolveEditStep(["toko", "foto"], { canManageProducts: true })).toBe("toko");
  });

  it("defaults to step 1, or to Toko online for a content-only session", () => {
    expect(resolveEditStep(undefined, { canManageProducts: true })).toBe("info");
    expect(resolveEditStep("nope", { canManageProducts: true })).toBe("info");
    expect(resolveEditStep(undefined, { canManageProducts: false })).toBe("toko");
  });

  it("still opens an explicitly requested step for a content-only session", () => {
    expect(resolveEditStep("foto", { canManageProducts: false })).toBe("foto");
  });
});

describe("resolveCreateStep", () => {
  it("keeps a valid step/reached pair unchanged", () => {
    expect(resolveCreateStep("foto", "toko", { hasVariants: true })).toEqual({ step: "foto", reached: "toko", changed: false });
    expect(resolveCreateStep("varian", "varian", { hasVariants: false })).toEqual({ step: "varian", reached: "varian", changed: false });
  });

  it("blocks every step after Varian while the product has no variant", () => {
    expect(resolveCreateStep("foto", "foto", { hasVariants: false })).toEqual({ step: "varian", reached: "varian", changed: true });
    expect(resolveCreateStep("aksesoris", "aksesoris", { hasVariants: false })).toMatchObject({ step: "varian", changed: true });
  });

  it("never lets a step beyond `reached` open", () => {
    expect(resolveCreateStep("aksesoris", "foto", { hasVariants: true })).toEqual({ step: "foto", reached: "foto", changed: true });
    expect(resolveCreateStep("aksesoris", undefined, { hasVariants: true })).toEqual({ step: "foto", reached: "foto", changed: true });
  });

  it("raises `reached` to Foto once a variant exists", () => {
    expect(resolveCreateStep("info", "varian", { hasVariants: true })).toEqual({ step: "info", reached: "foto", changed: true });
    expect(resolveCreateStep("info", undefined, { hasVariants: false })).toEqual({ step: "info", reached: "varian", changed: true });
  });

  it("falls back to Varian for a missing or unknown step", () => {
    expect(resolveCreateStep(undefined, undefined, { hasVariants: false })).toEqual({ step: "varian", reached: "varian", changed: true });
    expect(resolveCreateStep("x", "y", { hasVariants: true })).toEqual({ step: "varian", reached: "foto", changed: true });
  });
});

describe("productStepHref", () => {
  it("edit mode is the product page with ?step=", () => {
    expect(productStepHref(ID, "foto", "edit")).toBe(`/products/${ID}?step=foto`);
  });

  it("create mode keeps the furthest step reached", () => {
    expect(productStepHref(ID, "info", "create", "toko")).toBe(`/products/${ID}/setup?step=info&reached=toko`);
    expect(productStepHref(ID, "aksesoris", "create", "toko")).toBe(`/products/${ID}/setup?step=aksesoris&reached=aksesoris`);
    expect(productStepHref(ID, "varian", "create")).toBe(`/products/${ID}/setup?step=varian&reached=varian`);
  });
});

describe("buildStepItems", () => {
  it("before the product exists, only step 1 is there and every other step is locked", () => {
    const items = buildStepItems({ mode: "create", productId: null, current: "info", reached: "info" });
    expect(items.map((item) => [item.status, item.href])).toEqual([
      ["current", null],
      ["upcoming", null],
      ["upcoming", null],
      ["upcoming", null],
      ["upcoming", null],
    ]);
  });

  it("create mode: steps before `reached` are done, reachable steps are links, later ones are locked", () => {
    const items = buildStepItems({ mode: "create", productId: ID, current: "varian", reached: "foto" });
    expect(items.map((item) => item.status)).toEqual(["done", "current", "upcoming", "upcoming", "upcoming"]);
    expect(items[0]!.href).toBe(`/products/${ID}/setup?step=info&reached=foto`);
    expect(items[2]!.href).toBe(`/products/${ID}/setup?step=foto&reached=foto`);
    expect(items[3]!.href).toBeNull();
    expect(items[4]!.href).toBeNull();
  });

  it("edit mode: every step is a link; done marks come from the product's data", () => {
    const items = buildStepItems({
      mode: "edit",
      productId: ID,
      current: "foto",
      completion: { ...NOTHING, hasVariants: true, hasRecipe: true },
    });
    expect(items.map((item) => item.status)).toEqual(["done", "done", "current", "upcoming", "done"]);
    expect(items.every((item) => item.href !== null)).toBe(true);
    expect(items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("stepPositionLabel", () => {
  it("reads 'Langkah N dari 5 · Title'", () => {
    expect(stepPositionLabel("varian")).toBe("Langkah 2 dari 5 · Varian");
    expect(stepPositionLabel("aksesoris")).toBe("Langkah 5 dari 5 · Aksesoris");
  });
});

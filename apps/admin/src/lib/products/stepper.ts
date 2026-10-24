// The admin product page's 5-step wizard (docs/plans/product-stepper.md): step definitions, the
// URL each step lives at, create-mode clamping and the indicator's per-step state. Pure, so the
// server page, the client stepper and the tests all share one source of truth.

export const PRODUCT_STEP_KEYS = ["info", "varian", "foto", "toko", "aksesoris"] as const;
export type ProductStepKey = (typeof PRODUCT_STEP_KEYS)[number];

export interface ProductStepDefinition {
  key: ProductStepKey;
  title: string;
  description: string;
  /** Create mode only: "Lewati" moves on without saving. */
  skippable: boolean;
}

export const PRODUCT_STEPS: readonly ProductStepDefinition[] = [
  { key: "info", title: "Info produk", description: "Info dasar, harga, diskon", skippable: false },
  { key: "varian", title: "Varian", description: "Warna dan ukuran", skippable: false },
  { key: "foto", title: "Foto", description: "Foto produk", skippable: true },
  { key: "toko", title: "Toko online", description: "Tampilan di toko", skippable: true },
  { key: "aksesoris", title: "Aksesoris", description: "Aksesoris paket", skippable: true },
];

export type ProductStepperMode = "create" | "edit";

export function isProductStepKey(value: unknown): value is ProductStepKey {
  return typeof value === "string" && (PRODUCT_STEP_KEYS as readonly string[]).includes(value);
}

export function stepIndex(key: ProductStepKey): number {
  return PRODUCT_STEP_KEYS.indexOf(key);
}

export function stepAt(index: number): ProductStepKey {
  const clamped = Math.min(Math.max(index, 0), PRODUCT_STEP_KEYS.length - 1);
  return PRODUCT_STEP_KEYS[clamped]!;
}

export function stepDefinition(key: ProductStepKey): ProductStepDefinition {
  return PRODUCT_STEPS[stepIndex(key)]!;
}

/** A search param as Next hands it over: absent, one value, or repeated. */
type SearchParamValue = string | string[] | undefined;

function firstValue(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Edit mode: an unknown or missing `?step=` opens the first step the session can change. A
 * `content.manage`-only session can change nothing but the Toko online section. */
export function resolveEditStep(raw: SearchParamValue, { canManageProducts }: { canManageProducts: boolean }): ProductStepKey {
  const value = firstValue(raw);
  if (isProductStepKey(value)) return value;
  return canManageProducts ? "info" : "toko";
}

export interface CreateStepResolution {
  step: ProductStepKey;
  reached: ProductStepKey;
  /** True when the URL asked for something else and the page must redirect to `step`/`reached`. */
  changed: boolean;
}

/** Create mode (`/products/[id]/setup`): `reached` is the furthest step the owner has got to.
 * Steps up to it can be opened; anything later is locked (a hand-typed later `step` falls back
 * to `reached`; "Lanjut"/"Lewati" raise `reached` through productStepHref). The product already exists (step 1 was
 * saved), so `varian` is always reachable; without a variant nothing after it is, whatever the
 * URL says. */
export function resolveCreateStep(
  rawStep: SearchParamValue,
  rawReached: SearchParamValue,
  { hasVariants }: { hasVariants: boolean },
): CreateStepResolution {
  const stepValue = firstValue(rawStep);
  const reachedValue = firstValue(rawReached);
  const requested = isProductStepKey(stepValue) ? stepValue : "varian";
  const requestedReached = isProductStepKey(reachedValue) ? reachedValue : "varian";

  const ceiling = hasVariants ? PRODUCT_STEP_KEYS.length - 1 : stepIndex("varian");
  const floor = hasVariants ? stepIndex("foto") : stepIndex("varian");
  const reachedIndex = Math.min(Math.max(stepIndex(requestedReached), floor), ceiling);
  const step = stepAt(Math.min(stepIndex(requested), reachedIndex));
  const reached = stepAt(reachedIndex);
  return { step, reached, changed: step !== stepValue || reached !== reachedValue };
}

/** Where step `key` of product `productId` lives. Create mode keeps `reached` so going back never
 * locks the steps already passed. */
export function productStepHref(
  productId: string,
  key: ProductStepKey,
  mode: ProductStepperMode,
  reached?: ProductStepKey,
): string {
  if (mode === "edit") return `/products/${productId}?step=${key}`;
  const furthest = reached && stepIndex(reached) > stepIndex(key) ? reached : key;
  return `/products/${productId}/setup?step=${key}&reached=${furthest}`;
}

export type ProductStepStatus = "current" | "done" | "upcoming";

export interface ProductStepItem extends ProductStepDefinition {
  number: number;
  status: ProductStepStatus;
  /** null = locked: shown, but not a link. */
  href: string | null;
}

/** Edit mode's "done" marks, from what the product already has. */
export interface ProductStepCompletion {
  hasVariants: boolean;
  hasPhotos: boolean;
  isPublished: boolean;
  hasRecipe: boolean;
}

export function editCompletion(completion: ProductStepCompletion): Record<ProductStepKey, boolean> {
  return {
    info: true,
    varian: completion.hasVariants,
    foto: completion.hasPhotos,
    toko: completion.isPublished,
    aksesoris: completion.hasRecipe,
  };
}

export type BuildStepItemsInput =
  | { mode: "create"; productId: string | null; current: ProductStepKey; reached: ProductStepKey }
  | { mode: "edit"; productId: string; current: ProductStepKey; completion: ProductStepCompletion };

export function buildStepItems(input: BuildStepItemsInput): ProductStepItem[] {
  const currentIndex = stepIndex(input.current);

  if (input.mode === "edit") {
    const done = editCompletion(input.completion);
    return PRODUCT_STEPS.map((step, index) => ({
      ...step,
      number: index + 1,
      status: index === currentIndex ? "current" : done[step.key] ? "done" : "upcoming",
      href: productStepHref(input.productId, step.key, "edit"),
    }));
  }

  const { productId } = input;
  const reachedIndex = productId === null ? 0 : Math.max(stepIndex(input.reached), currentIndex);
  return PRODUCT_STEPS.map((step, index) => ({
    ...step,
    number: index + 1,
    status: index === currentIndex ? "current" : index < reachedIndex ? "done" : "upcoming",
    href: productId !== null && index <= reachedIndex ? productStepHref(productId, step.key, "create", stepAt(reachedIndex)) : null,
  }));
}

/** The phone line under the circles: "Langkah 2 dari 5 · Varian". */
export function stepPositionLabel(key: ProductStepKey): string {
  return `Langkah ${stepIndex(key) + 1} dari ${PRODUCT_STEP_KEYS.length} · ${stepDefinition(key).title}`;
}

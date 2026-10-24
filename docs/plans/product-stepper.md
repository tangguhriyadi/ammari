# Product stepper (create + edit wizard)

The owner's decisions are final (request of 2026-10-24). This plan records how they are built.
Admin only (`apps/admin`). No schema change, no new server action, no new dependency.

## Steps

| # | key (`?step=`) | Title       | Description                | Sections (unchanged)                                      |
|---|----------------|-------------|----------------------------|-----------------------------------------------------------|
| 1 | `info`         | Info produk | Info dasar, harga, diskon  | `ProductForm` (+ Batas HPP card), `DiscountSection`       |
| 2 | `varian`       | Varian      | Warna dan ukuran           | `VariantBuilder`                                          |
| 3 | `foto`         | Foto        | Foto produk                | `ProductPhotosSection`                                    |
| 4 | `toko`         | Toko online | Tampilan di toko           | `StorefrontSection` (publish switch, description, chart)  |
| 5 | `aksesoris`    | Aksesoris   | Aksesoris paket            | `AccessoryRecipeSection`                                  |

The owner named step 4 "Toko online dan deskripsi"; the bar uses the short title "Toko online"
so five titles plus descriptions fit one row at 1280px. Step 1 had no title in the request:
"Info produk".

Step definitions, URL building, create-mode clamping and indicator states live in one pure
module, `src/lib/products/stepper.ts`, unit tested.

## Routes

- `/products/new`: create, step 1. No product exists yet, so steps 2 to 5 are locked. "Lanjut"
  runs the existing `createProductAction`. The product is created exactly as today: not
  published on the storefront (`is_published_on_storefront` defaults to false), i.e. a draft.
  The discount needs a saved base price (`DiscountSection` checks against the stored price), so
  on this page step 1 shows a short note instead; it is fully usable when the owner goes back to
  step 1 of the saved draft.
- `/products/[id]/setup?step=<key>&reached=<key>`: create mode for a saved draft (steps 1 to 5).
  `reached` is the furthest step the owner has got to; steps up to it can be opened, later ones
  are locked. The server clamps it: without any variant nothing after `varian` can be opened
  (a hand-typed URL redirects back). Requires `products.manage`.
- `/products/[id]?step=<key>`: edit mode, every step can be opened. Missing/unknown `step` opens
  `info` (or `toko` for a session with `content.manage` only, since that is the only section it
  can change). Existing links (`/products/[id]` from the list, production cost lines, the old
  `/produk/:id` redirect) keep working and land on step 1. The Toko online card's
  "Buka bagian Foto" (the only link that targeted a section) now opens `?step=foto` and focuses
  the Foto heading.

## Buttons

- Create mode: Kembali (previous step), Lewati (foto, toko, aksesoris: move on without saving),
  Lanjut (save the step, then move on), Selesai on step 5 (save, then open `/products/[id]`).
  Varian needs at least one variant: Lanjut adds ticked-but-not-added colour/size selections
  first, then refuses with a message if the product still has none.
- Edit mode: Kembali / Lanjut only move between steps; each section keeps its own save buttons
  and behaviour (ProductForm's Simpan still returns to the list, as today).
- "Lanjut saves" works through a small client registry (`ProductStepper` context): a section
  registers `{ dirty, save }` with `useStepSection`. The sections' save code is refactored into
  `async persist(): Promise<boolean>` that both their own button and the stepper call, so
  validation, permission checks, audit logs, discount rules and the base-price message stay the
  server actions' job, exactly as today.

## Unsaved changes

Any step switch that does not save (indicator click, Kembali, Lewati, edit-mode Lanjut,
"Buka bagian Foto") checks the registry. If a section is dirty, the existing `Dialog` component
asks "Ada perubahan yang belum disimpan" (Tetap di sini / Buang perubahan). Stepper links carry
`data-skip-unsaved-guard`, so the page-wide `useUnsavedChangesGuard` (window.confirm on leaving
the page) does not also fire for them; leaving the product page entirely keeps today's guard.

## Step indicator

`<nav aria-label="Langkah produk">` with an `<ol>`. Current step: `aria-current="step"`, filled
`bg-brand` circle with white number. Done: brand-coloured circle with a check, a link. Upcoming:
neutral-200 circle, grey title/description; a link when reachable, otherwise a plain
non-focusable item with an `sr-only` "(terkunci, selesaikan langkah sebelumnya dulu)". Lines
between steps are `flex-1` and brand-coloured once the step before them is done.
At `lg` (desktop) title + description show beside the circle; below `lg` only small circles
with lines, plus "Langkah 2 dari 5 · Varian". It sits in a `Card` at the top of the page; a
divider separates it from the step content.

Done states: create mode, every step before `reached`. Edit mode, from data: info always,
varian with at least one variant, foto with at least one photo, toko when published, aksesoris
with at least one recipe row.

## Tests

- Unit (vitest): `stepper.test.ts` (parsing, defaults, clamping, hrefs, states, locked items),
  `product-stepper.test.tsx` (indicator rendering/a11y, dirty confirm, Lanjut saves, Lewati).
- E2E: new `product-stepper.spec.ts` at 1280px and 390px: create full path, skip path,
  forward jump blocked (indicator + URL), leave midway and resume from the edit page, edit
  `?step=` direct link, unsaved-changes confirm, indicator states. New fixture email
  `E2E_PRODUCT_STEPPER_EMAIL` (owner role).
- Existing specs: every spec that creates a product goes through ONE new shared helper,
  `e2e/helpers/product.ts`: `createProductDraft(page, {...})` fills step 1 on `/products/new`,
  clicks Lanjut, waits for `/products/<id>/setup?step=varian` and returns `{ productId, code }`;
  `addVariants(page, color, sizes)`; `openProductStep(page, id, step)`. Specs that used to find
  every section on one page open the step they need (`?step=foto`, `?step=toko`, ...).
  `helpers/publishable-product.ts` is rebuilt on top of it. Specs whose subject is step 1
  (types, highlights, shipping weight, discount, fresh-after-save) keep testing the same
  behaviour on step 1.
- Admin has no visual screenshot spec, so there is nothing to add there.

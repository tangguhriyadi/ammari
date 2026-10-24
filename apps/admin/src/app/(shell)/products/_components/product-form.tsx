"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Select, Switch, Textarea, useToast } from "@ammari/ui";
import type { ProductClosure, SizeMode } from "@ammari/db/schema";
import type { ProductHighlightKey } from "@ammari/db/highlights";
import { generateProductCode, generateSlug } from "@ammari/db/catalog";
import { productStepHref } from "@/lib/products/stepper";
import { createProductAction, revalidateProductAction, updateProductAction } from "../actions";
import { HighlightsEditor } from "./highlights-editor";
import { focusStepAfterNavigation, useStepSection } from "./product-stepper";

export interface Fabric {
  id: string;
  name: string;
}

export interface ProductTypeChoice {
  code: string;
  name: string;
}

/** The product's saved type, so one deactivated since still shows (marked) and re-saves. */
export interface CurrentProductType extends ProductTypeChoice {
  isActive: boolean;
}

export interface ProductFormValues {
  name: string;
  code: string;
  slug: string;
  fabricId: string;
  closure: ProductClosure;
  sizeMode: SizeMode;
  basePrice: string;
  description: string;
  isActive: boolean;
  highlights: ProductHighlightKey[];
  /** Whole grams as typed, "" when not filled in yet. */
  shippingWeightGrams: string;
  /** "" until one is picked (create). */
  productTypeCode: string;
}

const EMPTY_VALUES: ProductFormValues = {
  name: "",
  code: "",
  slug: "",
  fabricId: "",
  closure: "front_zip",
  sizeMode: "sized",
  basePrice: "",
  description: "",
  isActive: true,
  highlights: [],
  shippingWeightGrams: "",
  productTypeCode: "",
};

export function ProductForm({
  productId,
  fabrics,
  productTypes,
  currentProductType = null,
  initialValues,
  hasVariants = false,
  afterUpdate = "list",
}: {
  productId?: string;
  fabrics: Fabric[];
  /** ACTIVE types only (listActiveProductTypeOptions) — an inactive type is never a new choice. */
  productTypes: ProductTypeChoice[];
  currentProductType?: CurrentProductType | null;
  initialValues?: ProductFormValues;
  /** Once true, the fabric AND closure selects are disabled — neither can change once the
   * product has a variant (the composite FK in migration 0007 enforces this at the DB level;
   * this is just the friendly, don't-let-the-user-try-it-in-the-first-place version). */
  hasVariants?: boolean;
  /** After a successful update: back to the list (edit mode, as before the stepper), or stay on
   * this step (create mode's step 1 of a saved draft, where "Lanjut" moves on). */
  afterUpdate?: "list" | "stay";
}) {
  const router = useRouter();
  const toast = useToast();
  const isCreate = !productId;
  const [values, setValues] = useState<ProductFormValues>(initialValues ?? EMPTY_VALUES);
  // What the server holds as of the last load or save, for the stepper's unsaved-changes check
  // (the refreshed props can differ in format, e.g. "269.000" typed vs "269000" stored).
  const [savedValues, setSavedValues] = useState<ProductFormValues>(initialValues ?? EMPTY_VALUES);
  const [codeTouched, setCodeTouched] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Soft warning — the save itself succeeded; only the on-demand storefront cache invalidation
  // failed (docs/plans/storefront-cms.md session 6). Shown once, right after a successful
  // update, cleared again on the next save attempt.
  const [revalidationWarning, setRevalidationWarning] = useState(false);
  const [retryPending, startRetry] = useTransition();
  // A type deactivated after this product picked it isn't in `productTypes` any more; it's still
  // this product's value, so it's rendered (marked) instead of the select silently showing blank.
  const currentTypeIsMissing =
    currentProductType !== null && !productTypes.some((productType) => productType.code === currentProductType.code);

  function handleNameChange(name: string) {
    setValues((prev) => ({
      ...prev,
      name,
      code: isCreate && !codeTouched ? generateProductCode(name) : prev.code,
      slug: isCreate && !slugTouched ? generateSlug(name) : prev.slug,
    }));
  }

  function set<K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  // Only a saved product takes part in the stepper's checks: on /products/new this form's own
  // "Lanjut" is the only way forward.
  useStepSection(productId !== undefined && JSON.stringify(values) !== JSON.stringify(savedValues), () => persist("stay"));

  /** Saves the form; resolves true once the product is saved and nothing needs the owner's
   * attention on this step any more. */
  async function persist(after: "list" | "stay"): Promise<boolean> {
    setFormError(null);
    setFieldErrors({});
    setRevalidationWarning(false);
    const common = {
      name: values.name,
      slug: values.slug,
      fabricId: values.fabricId,
      closure: values.closure,
      basePrice: values.basePrice,
      description: values.description || undefined,
      isActive: values.isActive,
      highlights: values.highlights,
      shippingWeightGrams: values.shippingWeightGrams,
      productTypeCode: values.productTypeCode,
    };
    const result = productId
      ? await updateProductAction(productId, common)
      : await createProductAction({ ...common, code: values.code, sizeMode: values.sizeMode });
    if (!result.ok) {
      setFormError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
      // Nothing was saved (the whole update is one transaction, including on an unrelated
      // field error like a duplicate slug) — revert to what the server actually still has,
      // not unconditionally to OFF: an already-active product that fails to save for a
      // reason unrelated to activation must keep showing as active, never a false "this
      // product is now inactive" state. On create (no `initialValues`), there's no prior
      // server truth to revert to, so the user's own attempt is left as they set it.
      if (productId && initialValues) set("isActive", initialValues.isActive);
      return false;
    }
    setSavedValues(values);
    // Only updateProductAction's result carries `revalidationOk` — createProductAction has
    // nothing to revalidate yet (a brand-new product is never published on the storefront).
    if ("revalidationOk" in result.data && !result.data.revalidationOk) {
      // Saved, but the storefront is stale: stay on the form so this warning (and its retry
      // button) stays visible instead of being lost to a redirect.
      setRevalidationWarning(true);
      router.refresh();
      return false;
    }
    if (!productId) {
      // Step 1 of the stepper (docs/plans/product-stepper.md): saved as a draft, which is
      // never on the storefront until the owner publishes it in step 4. On to Varian.
      toast.success("Produk tersimpan sebagai draf. Belum tampil di toko online.");
      focusStepAfterNavigation();
      router.push(productStepHref(result.data.id, "varian", "create"));
      return true;
    }
    toast.success("Perubahan berhasil disimpan");
    if (after === "list") router.push("/products");
    else router.refresh();
    return true;
  }

  function handleSubmit() {
    startTransition(async () => {
      await persist(afterUpdate);
    });
  }

  function handleRetryRevalidation() {
    if (!productId) return;
    startRetry(async () => {
      const result = await revalidateProductAction(productId);
      setRevalidationWarning(!(result.ok && result.data.revalidationOk));
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      className="flex max-w-xl flex-col gap-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-name" required>
          Nama produk
        </Label>
        <Input
          id="product-name"
          value={values.name}
          onChange={(event) => handleNameChange(event.target.value)}
          placeholder="mis. Contoh Gamis A"
          error={fieldErrors.name}
          required
        />
      </div>

      {isCreate && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="product-code" required>
              Kode produk
            </Label>
            <Input
              id="product-code"
              value={values.code}
              onChange={(event) => {
                setCodeTouched(true);
                set("code", event.target.value.toUpperCase());
              }}
              error={fieldErrors.code}
              required
            />
            <p className="text-sm text-neutral-600">
              Dipakai untuk kode SKU dan tidak bisa diubah setelah produk disimpan.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="product-size-mode" required>
              Ukuran
            </Label>
            <Select
              id="product-size-mode"
              value={values.sizeMode}
              onChange={(event) => set("sizeMode", event.target.value as ProductFormValues["sizeMode"])}
              error={fieldErrors.sizeMode}
            >
              <option value="sized">Ukuran XS–XL</option>
              <option value="all_size">All Size</option>
            </Select>
            <p className="text-sm text-neutral-600">Tidak bisa diubah setelah produk disimpan.</p>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-slug" required>
          Slug
        </Label>
        <Input
          id="product-slug"
          value={values.slug}
          onChange={(event) => {
            setSlugTouched(true);
            set("slug", event.target.value);
          }}
          error={fieldErrors.slug}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-type" required>
          Jenis produk
        </Label>
        <Select
          id="product-type"
          value={values.productTypeCode}
          onChange={(event) => set("productTypeCode", event.target.value)}
          error={fieldErrors.productTypeCode}
          required
        >
          <option value="">Pilih jenis produk</option>
          {currentTypeIsMissing && (
            <option value={currentProductType.code}>
              {currentProductType.isActive ? currentProductType.name : `${currentProductType.name} (nonaktif)`}
            </option>
          )}
          {productTypes.map((productType) => (
            <option key={productType.code} value={productType.code}>
              {productType.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-fabric" required>
          Bahan
        </Label>
        <Select
          id="product-fabric"
          value={values.fabricId}
          onChange={(event) => set("fabricId", event.target.value)}
          error={fieldErrors.fabricId}
          disabled={hasVariants}
          required
        >
          <option value="">Pilih bahan</option>
          {fabrics.map((fabric) => (
            <option key={fabric.id} value={fabric.id}>
              {fabric.name}
            </option>
          ))}
        </Select>
        {hasVariants && (
          <p className="text-sm text-neutral-600">
            Bahan tidak bisa diganti setelah varian dibuat. Buat produk baru untuk bahan lain.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-closure" required>
          Model resleting
        </Label>
        <Select
          id="product-closure"
          value={values.closure}
          onChange={(event) => set("closure", event.target.value as ProductFormValues["closure"])}
          error={fieldErrors.closure}
          disabled={hasVariants}
        >
          <option value="front_zip">Resleting depan</option>
          <option value="back_zip">Resleting belakang</option>
        </Select>
        {hasVariants && (
          <p className="text-sm text-neutral-600">
            Model resleting tidak bisa diganti setelah varian dibuat, karena sudah menjadi bagian dari kode SKU.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-base-price" required>
          Harga dasar
        </Label>
        <Input
          id="product-base-price"
          inputMode="numeric"
          value={values.basePrice}
          onChange={(event) => set("basePrice", event.target.value)}
          placeholder="mis. 269.000"
          error={fieldErrors.basePrice}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-shipping-weight">Berat kirim (gram)</Label>
        <Input
          id="product-shipping-weight"
          inputMode="numeric"
          value={values.shippingWeightGrams}
          onChange={(event) => set("shippingWeightGrams", event.target.value)}
          placeholder="mis. 850"
          aria-describedby="product-shipping-weight-hint"
          error={fieldErrors.shippingWeightGrams}
        />
        <p id="product-shipping-weight-hint" className="text-sm text-neutral-600">
          Berat 1 pcs yang sudah dilipat dan dibungkus plastik. Wajib diisi sebelum produk bisa ditayangkan di toko online.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-description">Deskripsi</Label>
        <Textarea
          id="product-description"
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          error={fieldErrors.description}
        />
      </div>

      <HighlightsEditor selected={values.highlights} onChange={(highlights) => set("highlights", highlights)} />

      <Switch label="Aktif" checked={values.isActive} onCheckedChange={(checked) => set("isActive", checked)} />

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
        </p>
      )}

      {revalidationWarning && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-amber-800" data-testid="revalidation-warning">
          Perubahan tersimpan, tetapi toko online belum diperbarui.
          <button type="button" onClick={handleRetryRevalidation} disabled={retryPending} className="font-medium underline disabled:opacity-60">
            Coba lagi
          </button>
        </p>
      )}

      <div className="flex justify-end gap-2">
        {isCreate && (
          <Link href="/products">
            <Button type="button" variant="secondary">
              Batal
            </Button>
          </Link>
        )}
        <Button type="submit" loading={pending}>
          {isCreate ? "Lanjut" : "Simpan"}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Select, Switch, Textarea } from "@ammari/ui";
import type { ProductClosure, SizeMode } from "@ammari/db/schema";
import { generateProductCode, generateSlug } from "@ammari/db/catalog";
import { createProductAction, updateProductAction } from "../actions";

export interface Fabric {
  id: string;
  name: string;
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
};

export function ProductForm({
  productId,
  fabrics,
  initialValues,
  hasVariants = false,
}: {
  productId?: string;
  fabrics: Fabric[];
  initialValues?: ProductFormValues;
  /** Once true, the fabric AND closure selects are disabled — neither can change once the
   * product has a variant (the composite FK in migration 0007 enforces this at the DB level;
   * this is just the friendly, don't-let-the-user-try-it-in-the-first-place version). */
  hasVariants?: boolean;
}) {
  const router = useRouter();
  const isCreate = !productId;
  const [values, setValues] = useState<ProductFormValues>(initialValues ?? EMPTY_VALUES);
  const [codeTouched, setCodeTouched] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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

  function handleSubmit() {
    setFormError(null);
    setFieldErrors({});
    startTransition(async () => {
      const common = {
        name: values.name,
        slug: values.slug,
        fabricId: values.fabricId,
        closure: values.closure,
        basePrice: values.basePrice,
        description: values.description || undefined,
        isActive: values.isActive,
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
        return;
      }
      router.push(`/products/${result.data.id}`);
      router.refresh();
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
        <Label htmlFor="product-description">Deskripsi</Label>
        <Textarea
          id="product-description"
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          error={fieldErrors.description}
        />
      </div>

      <Switch label="Aktif" checked={values.isActive} onCheckedChange={(checked) => set("isActive", checked)} />

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
        </p>
      )}

      <Button type="submit" loading={pending}>
        Simpan
      </Button>
    </form>
  );
}

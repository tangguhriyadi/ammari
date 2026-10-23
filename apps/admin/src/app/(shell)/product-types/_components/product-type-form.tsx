"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Switch, useToast } from "@ammari/ui";
import { createProductTypeAction, updateProductTypeAction } from "../actions";

export interface ProductTypeFormValues {
  code: string;
  name: string;
  sortOrder: string;
  isActive: boolean;
}

// A discriminated union, same reasoning as SupplierFormProps: "edit" always has the code it
// submits to. The code is only typed on create — it's immutable afterwards.
export type ProductTypeFormProps =
  | { mode: "create"; initialValues: ProductTypeFormValues }
  | { mode: "edit"; code: string; initialValues: ProductTypeFormValues };

export function ProductTypeForm(props: ProductTypeFormProps) {
  const { initialValues } = props;
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState(initialValues.code);
  const [name, setName] = useState(initialValues.name);
  const [sortOrder, setSortOrder] = useState(initialValues.sortOrder);
  const [isActive, setIsActive] = useState(initialValues.isActive);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  function handleSubmit() {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const fields = { name, sortOrder: sortOrder.trim() === "" ? 0 : sortOrder, isActive };
      const result =
        props.mode === "create" ? await createProductTypeAction({ ...fields, code }) : await updateProductTypeAction(props.code, fields);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      toast.success(props.mode === "create" ? "Jenis produk berhasil ditambahkan" : "Perubahan berhasil disimpan");
      router.push("/product-types");
    });
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-type-code" required={props.mode === "create"}>
          Kode
        </Label>
        {props.mode === "create" ? (
          <Input
            id="product-type-code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="mis. DRESS"
            autoCapitalize="characters"
            aria-describedby="product-type-code-hint"
            error={fieldErrors.code}
            required
          />
        ) : (
          <Input id="product-type-code" value={code} readOnly disabled aria-describedby="product-type-code-hint" />
        )}
        <p id="product-type-code-hint" className="text-sm text-neutral-600">
          Huruf besar, angka, dan garis bawah. Tidak bisa diubah setelah disimpan.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-type-name" required>
          Nama tampilan
        </Label>
        <Input
          id="product-type-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="mis. Gamis"
          error={fieldErrors.name}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-type-sort-order">Urutan tampil</Label>
        <Input
          id="product-type-sort-order"
          inputMode="numeric"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
          aria-describedby="product-type-sort-order-hint"
          error={fieldErrors.sortOrder}
        />
        <p id="product-type-sort-order-hint" className="text-sm text-neutral-600">
          Angka kecil tampil lebih dulu di pilihan jenis produk.
        </p>
      </div>

      <Switch checked={isActive} onCheckedChange={setIsActive} label="Aktif" />

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {props.mode === "create" && (
          <Link href="/product-types">
            <Button type="button" variant="secondary">
              Batal
            </Button>
          </Link>
        )}
        <Button type="submit" loading={saving}>
          Simpan
        </Button>
      </div>
    </form>
  );
}

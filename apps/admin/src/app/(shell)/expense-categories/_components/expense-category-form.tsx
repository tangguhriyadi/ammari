"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { EXPENSE_CATEGORY_KINDS, type ExpenseCategoryKind } from "@ammari/db/schema";
import { Button, Input, Label, useToast } from "@ammari/ui";
import { EXPENSE_CATEGORY_KIND_LABELS } from "@/lib/expense-categories/catalog";
import { createExpenseCategoryAction, updateExpenseCategoryAction } from "../actions";

const KIND_HINTS: Record<ExpenseCategoryKind, string> = {
  ad: "Dihitung di biaya iklan dan ROAS.",
  endorsement: "Biaya pemasaran, tidak dihitung di ROAS.",
  operating: "Biaya operasional, tanpa kanal.",
};

// Same discriminated-union shape as ProductTypeForm: "edit" always has the code it submits to.
// The kind is chosen only on create; afterwards it is immutable (plan §3.1), shown read-only.
export type ExpenseCategoryFormProps =
  | { mode: "create" }
  | { mode: "edit"; code: string; kind: ExpenseCategoryKind; initialValues: { name: string; sortOrder: string } };

export function ExpenseCategoryForm(props: ExpenseCategoryFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(props.mode === "edit" ? props.initialValues.name : "");
  const [sortOrder, setSortOrder] = useState(props.mode === "edit" ? props.initialValues.sortOrder : "0");
  const [kind, setKind] = useState<ExpenseCategoryKind | "">("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();
  // Stays true after a successful create while router.push navigates away, so a second click
  // cannot re-post the same name.
  const [created, setCreated] = useState(false);

  function handleSubmit() {
    if (saving || created) return;
    setError(null);
    setFieldErrors({});
    if (props.mode === "create" && kind === "") {
      setFieldErrors({ kind: "Pilih jenis: Iklan, Endorse, atau Operasional." });
      return;
    }
    startTransition(async () => {
      const fields = { name, sortOrder: sortOrder.trim() === "" ? 0 : sortOrder };
      if (props.mode === "create") {
        const result = await createExpenseCategoryAction({ ...fields, kind: kind as ExpenseCategoryKind });
        if (!result.ok) {
          setError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
          return;
        }
        setCreated(true);
        toast.success("Kategori biaya berhasil ditambahkan");
        router.push(`/expense-categories/${result.data.code}`);
        return;
      }
      const result = await updateExpenseCategoryAction(props.code, fields);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      // A blank order was saved as 0; show it (the page's remount key may not change).
      if (sortOrder.trim() === "") setSortOrder("0");
      toast.success("Perubahan berhasil disimpan");
      router.refresh();
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
        <Label htmlFor="expense-category-name" required>
          Nama kategori
        </Label>
        <Input
          id="expense-category-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="mis. Langganan"
          maxLength={60}
          error={fieldErrors.name}
          required
          disabled={saving}
        />
      </div>

      {props.mode === "create" ? (
        <fieldset className="flex flex-col gap-2" aria-describedby="expense-category-kind-hint">
          <legend className="mb-1 text-base font-medium text-neutral-900">
            Jenis <span className="text-danger-700" aria-hidden="true">*</span>
          </legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {EXPENSE_CATEGORY_KINDS.map((option) => (
              <label key={option} className="flex min-h-11 items-center gap-2 text-base text-neutral-900">
                <input
                  type="radio"
                  name="expense-category-kind"
                  value={option}
                  checked={kind === option}
                  onChange={() => setKind(option)}
                  disabled={saving}
                  className="size-5 accent-brand"
                />
                {EXPENSE_CATEGORY_KIND_LABELS[option]}
              </label>
            ))}
          </div>
          <p id="expense-category-kind-hint" className="text-sm text-neutral-600">
            {kind === "" ? "Tidak bisa diubah setelah disimpan." : `${KIND_HINTS[kind]} Tidak bisa diubah setelah disimpan.`}
          </p>
          {fieldErrors.kind && (
            <p role="alert" className="text-sm text-danger-700">
              {fieldErrors.kind}
            </p>
          )}
        </fieldset>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-category-kind">Jenis</Label>
          <Input id="expense-category-kind" value={EXPENSE_CATEGORY_KIND_LABELS[props.kind]} readOnly disabled aria-describedby="expense-category-kind-hint" />
          <p id="expense-category-kind-hint" className="text-sm text-neutral-600">
            Jenis dan kode tidak bisa diubah. Kalau keliru, nonaktifkan kategori ini lalu buat yang baru.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="expense-category-sort-order">Urutan tampil</Label>
        <Input
          id="expense-category-sort-order"
          inputMode="numeric"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
          aria-describedby="expense-category-sort-order-hint"
          error={fieldErrors.sortOrder}
          disabled={saving}
        />
        <p id="expense-category-sort-order-hint" className="text-sm text-neutral-600">
          Angka kecil tampil lebih dulu di pilihan kategori.
        </p>
      </div>

      {error && !fieldErrors.name && !fieldErrors.sortOrder && !fieldErrors.kind && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {props.mode === "create" && (
          <Link href="/expense-categories">
            <Button type="button" variant="secondary">
              Batal
            </Button>
          </Link>
        )}
        <Button type="submit" loading={saving} disabled={created}>
          Simpan
        </Button>
      </div>
    </form>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Label, Select, Switch, Textarea } from "@ammari/ui";
import type { SizeMode } from "@ammari/db/schema";
import { updateProductStorefrontAction } from "../actions";
import { RichTextEditor } from "./rich-text-editor";

export interface SizeChartOption {
  id: string;
  name: string;
}

export interface StorefrontSectionValues {
  isPublishedOnStorefront: boolean;
  storefrontDescriptionHtml: string;
  allsizeFitNote: string;
  sizeChartId: string | null;
}

export function StorefrontSection({
  productId,
  sizeMode,
  isActive,
  initialValues,
  sizeCharts,
}: {
  productId: string;
  sizeMode: SizeMode;
  /** The product's CURRENT `is_active` value — used only to show the right guidance up front;
   * the real guard is server-side (updateProductStorefrontAction -> updateProductStorefront). */
  isActive: boolean;
  initialValues: StorefrontSectionValues;
  sizeCharts: SizeChartOption[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<StorefrontSectionValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof StorefrontSectionValues>(key: K, value: StorefrontSectionValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    setFormError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await updateProductStorefrontAction(productId, {
        isPublishedOnStorefront: values.isPublishedOnStorefront,
        storefrontDescriptionHtml: values.storefrontDescriptionHtml,
        allsizeFitNote: values.allsizeFitNote,
        sizeChartId: sizeMode === "sized" ? values.sizeChartId : null,
      });
      if (!result.ok) {
        setFormError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        // Same "revert to what the server actually still has" reasoning as ProductForm's own
        // handleSubmit — nothing was saved (one transaction), so a failure unrelated to the
        // toggle must not leave it visually flipped.
        set("isPublishedOnStorefront", initialValues.isPublishedOnStorefront);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4">
      <h2 className="text-lg font-semibold text-neutral-900">Storefront</h2>

      <Switch
        label="Tayang di storefront"
        checked={values.isPublishedOnStorefront}
        onCheckedChange={(checked) => set("isPublishedOnStorefront", checked)}
        error={fieldErrors.isPublishedOnStorefront}
      />
      {!isActive && !values.isPublishedOnStorefront && (
        <p className="text-sm text-neutral-600">Produk harus aktif terlebih dahulu sebelum bisa ditayangkan di storefront.</p>
      )}

      <RichTextEditor
        label="Deskripsi untuk toko"
        content={values.storefrontDescriptionHtml}
        onChange={(html) => set("storefrontDescriptionHtml", html)}
        error={fieldErrors.storefrontDescriptionHtml}
        data-testid="storefront-description-editor"
      />

      {sizeMode === "all_size" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="allsize-fit-note">Catatan ukuran (All Size)</Label>
          <Textarea
            id="allsize-fit-note"
            value={values.allsizeFitNote}
            onChange={(event) => set("allsizeFitNote", event.target.value)}
            placeholder="mis. Cocok untuk badan dengan tinggi 150-165 cm."
            error={fieldErrors.allsizeFitNote}
          />
          <p className="text-sm text-neutral-600">
            Ditampilkan di halaman produk sebagai pengganti tabel ukuran. Kosongkan untuk teks default &ldquo;Ukuran: All
            Size&rdquo;.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="size-chart-picker">Size chart</Label>
            <Link href="/content/size-charts" className="text-sm text-brand hover:underline">
              Kelola ukuran
            </Link>
          </div>
          <Select
            id="size-chart-picker"
            value={values.sizeChartId ?? ""}
            onChange={(event) => set("sizeChartId", event.target.value || null)}
            error={fieldErrors.sizeChartId}
          >
            <option value="">Belum dipilih</option>
            {sizeCharts.map((chart) => (
              <option key={chart.id} value={chart.id}>
                {chart.name}
              </option>
            ))}
          </Select>
          {!values.sizeChartId && <p className="text-sm text-neutral-600">Pilih size chart sebelum menayangkan produk ini.</p>}
        </div>
      )}

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="button" onClick={handleSave} loading={pending}>
          Simpan storefront
        </Button>
      </div>
    </div>
  );
}

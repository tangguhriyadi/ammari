"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Label, Select, Switch, Textarea } from "@ammari/ui";
import type { SizeMode } from "@ammari/db/schema";
import { revalidateProductAction, updateProductStorefrontAction } from "../actions";
import { PHOTO_SECTION_ID, PHOTO_SECTION_MESSAGES } from "@/lib/products/photo-messages";
import { RichTextEditor } from "./rich-text-editor";

/** Scrolls to the product page's Foto section and moves focus onto its heading, so keyboard and
 * screen reader users land there too. Replaces "lihat di bawah"-style copy: the section's position
 * relative to this card isn't something the messages should promise. */
function PhotoSectionLink() {
  return (
    <button
      type="button"
      onClick={() => {
        const target = document.getElementById(PHOTO_SECTION_ID);
        if (!target) return;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        target.focus({ preventScroll: true });
      }}
      className="font-medium text-brand underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      Buka bagian Foto
    </button>
  );
}

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
  photoCount,
  canOpenPhotos,
  initialValues,
  sizeCharts,
}: {
  productId: string;
  sizeMode: SizeMode;
  /** The product's CURRENT `is_active` value — used only to show the right guidance up front;
   * the real guard is server-side (updateProductStorefrontAction -> updateProductStorefront). */
  isActive: boolean;
  /** The product's CURRENT total photo count, for the same up-front guidance; the server
   * refuses publishing a product with no photo regardless (updateProductStorefront). */
  photoCount: number;
  /** Whether the Foto section is on this page for this session (it renders only with
   * products.manage) — the "Buka bagian Foto" jump is hidden when there is nothing to jump to. */
  canOpenPhotos: boolean;
  initialValues: StorefrontSectionValues;
  sizeCharts: SizeChartOption[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<StorefrontSectionValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [revalidationWarning, setRevalidationWarning] = useState(false);
  const [retryPending, startRetry] = useTransition();

  function set<K extends keyof StorefrontSectionValues>(key: K, value: StorefrontSectionValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    setFormError(null);
    setFieldErrors({});
    setRevalidationWarning(false);
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
      setRevalidationWarning(!result.data.revalidationOk);
      router.refresh();
    });
  }

  function handleRetryRevalidation() {
    startRetry(async () => {
      const result = await revalidateProductAction(productId);
      setRevalidationWarning(!(result.ok && result.data.revalidationOk));
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4" data-testid="storefront-section">
      <h2 className="text-lg font-semibold text-neutral-900">Toko online</h2>

      <Switch
        label="Tayang di toko online"
        checked={values.isPublishedOnStorefront}
        onCheckedChange={(checked) => set("isPublishedOnStorefront", checked)}
        error={fieldErrors.isPublishedOnStorefront}
      />
      {!isActive && !values.isPublishedOnStorefront && (
        <p className="text-sm text-neutral-600">Produk harus aktif terlebih dahulu sebelum bisa ditayangkan di toko online.</p>
      )}
      {photoCount === 0 && (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-neutral-600" data-testid="storefront-needs-photo">
          Unggah minimal satu foto di bagian Foto sebelum menayangkan produk ini di toko online.
          {canOpenPhotos && <PhotoSectionLink />}
        </p>
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
            <Label htmlFor="size-chart-picker">Tabel ukuran</Label>
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
          {!values.sizeChartId && <p className="text-sm text-neutral-600">Pilih tabel ukuran sebelum menayangkan produk ini.</p>}
        </div>
      )}

      {formError && (
        <p role="alert" className="flex flex-wrap items-center gap-x-2 text-sm text-danger-700">
          {formError}
          {canOpenPhotos && PHOTO_SECTION_MESSAGES.includes(formError) && <PhotoSectionLink />}
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

      <div className="flex justify-end">
        <Button type="button" onClick={handleSave} loading={pending}>
          Simpan
        </Button>
      </div>
    </div>
  );
}

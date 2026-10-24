"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Label, Select, Switch, Textarea } from "@ammari/ui";
import type { SizeMode } from "@ammari/db/schema";
import { revalidateProductAction, updateProductStorefrontAction } from "../actions";
import { PHOTO_SECTION_MESSAGES } from "@/lib/products/photo-messages";
import { RichTextEditor } from "./rich-text-editor";
import { SKIP_UNSAVED_GUARD, useStepNavigation, useStepSection } from "./product-stepper";

/** Opens the Foto step, where the Foto heading takes focus (ProductPhotosSection's `focusHeading`)
 * so keyboard and screen reader users land there too. Goes through the stepper, so unsaved edits
 * in this card are not lost silently. Replaces "lihat di bawah"-style copy: the Foto section's
 * position relative to this card isn't something the messages should promise. */
function PhotoSectionLink({ href }: { href: string }) {
  const navigate = useStepNavigation();
  return (
    <Link
      href={href}
      {...SKIP_UNSAVED_GUARD}
      onClick={(event) => {
        if (!navigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      }}
      className="font-medium text-brand underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      Buka bagian Foto
    </Link>
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
  photoStepHref,
  hasShippingWeight,
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
  /** The Foto step's URL, or null when this session can't manage photos (it needs
   * products.manage): the "Buka bagian Foto" jump is hidden when there is nothing to jump to. */
  photoStepHref: string | null;
  /** Whether the product's saved "Berat kirim" is set, for up-front guidance only; the server
   * refuses going live without one regardless (updateProductStorefront). */
  hasShippingWeight: boolean;
  initialValues: StorefrontSectionValues;
  sizeCharts: SizeChartOption[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<StorefrontSectionValues>(initialValues);
  const [savedValues, setSavedValues] = useState<StorefrontSectionValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [revalidationWarning, setRevalidationWarning] = useState(false);
  const [retryPending, startRetry] = useTransition();

  function set<K extends keyof StorefrontSectionValues>(key: K, value: StorefrontSectionValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  useStepSection(JSON.stringify(values) !== JSON.stringify(savedValues), persist);

  /** Resolves true once saved and the storefront is up to date; false keeps the owner on this
   * step to read the error or the "belum diperbarui" warning. */
  async function persist(): Promise<boolean> {
    setFormError(null);
    setFieldErrors({});
    setRevalidationWarning(false);
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
      set("isPublishedOnStorefront", savedValues.isPublishedOnStorefront);
      return false;
    }
    setSavedValues(values);
    setRevalidationWarning(!result.data.revalidationOk);
    router.refresh();
    return result.data.revalidationOk;
  }

  function handleSave() {
    startTransition(async () => {
      await persist();
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
          {photoStepHref && <PhotoSectionLink href={photoStepHref} />}
        </p>
      )}
      {!hasShippingWeight && (
        <p className="text-sm text-neutral-600" data-testid="storefront-needs-shipping-weight">
          {initialValues.isPublishedOnStorefront
            ? "Berat kirim belum diisi. Produk tetap tayang, tetapi ongkirnya belum bisa dihitung saat checkout. Isi berat kirim di data produk."
            : "Isi berat kirim di data produk sebelum menayangkan produk ini di toko online."}
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
          {photoStepHref && PHOTO_SECTION_MESSAGES.includes(formError) && <PhotoSectionLink href={photoStepHref} />}
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

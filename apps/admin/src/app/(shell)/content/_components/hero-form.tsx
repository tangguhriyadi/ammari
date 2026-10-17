"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Switch, Textarea } from "@ammari/ui";
import type { PublishableProductOption } from "@/lib/content/homepage";
import { HOMEPAGE_SECTION_LABELS, unpublishedSectionsBannerText } from "@/lib/content/homepage-types";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { publishHomepageAction, saveHeroDraftAction } from "../actions";
import { ContentImageField, type ContentImageFieldValue } from "./content-image-field";
import { ProductColorPicker, type ProductColorValue } from "./product-color-picker";
import { UnpublishedChangesBanner } from "./unpublished-changes-banner";

const SECTION_LABEL = HOMEPAGE_SECTION_LABELS.hero;

export interface HeroFormValues {
  isVisible: boolean;
  eyebrow: string;
  headline: string;
  ctaLabel: string;
  ctaTargetType: "anchor" | "product";
  ctaProduct: ProductColorValue | null;
  image: ContentImageFieldValue | null;
}

/** Strips client-only `previewUrl`/`mobile.previewUrl` and flattens the optional mobile crop
 * into contentImageSchema's shape — the server re-validates this (required altText, all-or-
 * nothing mobile fields) independently, this is just the wire shape. */
function toContentImagePayload(image: ContentImageFieldValue | null) {
  if (!image) return null;
  return {
    storageKey: image.storageKey,
    altText: image.altText,
    width: image.width,
    height: image.height,
    mobileStorageKey: image.mobile?.storageKey ?? null,
    mobileWidth: image.mobile?.width ?? null,
    mobileHeight: image.mobile?.height ?? null,
  };
}

export function HeroForm({
  initialValues,
  products,
  initialUnpublishedSectionLabels,
}: {
  initialValues: HeroFormValues;
  products: PublishableProductOption[];
  initialUnpublishedSectionLabels: string[];
}) {
  const router = useRouter();
  const [values, setValues] = useState(initialValues);
  const [savedValues, setSavedValues] = useState(initialValues);
  const [unpublishedSectionLabels, setUnpublishedSectionLabels] = useState(initialUnpublishedSectionLabels);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [publishPending, startPublishTransition] = useTransition();

  const dirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  useUnsavedChangesGuard(dirty);

  function set<K extends keyof HeroFormValues>(key: K, value: HeroFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    setFormError(null);
    startTransition(async () => {
      const result = await saveHeroDraftAction({
        isVisible: values.isVisible,
        content: {
          eyebrow: values.eyebrow,
          headline: values.headline,
          ctaLabel: values.ctaLabel,
          ctaTarget:
            values.ctaTargetType === "anchor"
              ? { type: "anchor" }
              : { type: "product", productId: values.ctaProduct?.productId ?? "", fabricColorId: values.ctaProduct?.fabricColorId ?? null },
          image: toContentImagePayload(values.image),
        },
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setSavedValues(values);
      setUnpublishedSectionLabels((prev) => (prev.includes(SECTION_LABEL) ? prev : [...prev, SECTION_LABEL]));
      router.refresh();
    });
  }

  function handlePublish() {
    setFormError(null);
    startPublishTransition(async () => {
      const result = await publishHomepageAction();
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      // Atomic publish — ALL sections are now in sync with their draft, not just this one.
      setUnpublishedSectionLabels([]);
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {unpublishedSectionLabels.length > 0 && (
        <UnpublishedChangesBanner onPublish={handlePublish} pending={publishPending} disabled={dirty} testId="hero-unpublished-banner">
          {unpublishedSectionsBannerText(unpublishedSectionLabels)}
        </UnpublishedChangesBanner>
      )}

      <Switch label="Tayang" checked={values.isVisible} onCheckedChange={(checked) => set("isVisible", checked)} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="hero-eyebrow">Eyebrow</Label>
        <Input
          id="hero-eyebrow"
          value={values.eyebrow}
          onChange={(event) => set("eyebrow", event.target.value)}
          placeholder="mis. Koleksi Terbaru"
          maxLength={60}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="hero-headline" required>
          Headline
        </Label>
        <Textarea
          id="hero-headline"
          value={values.headline}
          onChange={(event) => set("headline", event.target.value)}
          placeholder={"Gamis Syar'i\nuntuk Setiap Momen"}
          rows={3}
          maxLength={200}
          required
        />
        <p className="text-sm text-neutral-600">Tekan Enter untuk baris baru.</p>
      </div>

      <ContentImageField
        sectionKey="hero"
        label="Gambar hero"
        value={values.image}
        onChange={(image) => set("image", image)}
        allowMobileCrop
        disabled={pending}
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="hero-cta-label" required>
          Label tombol
        </Label>
        <Input
          id="hero-cta-label"
          value={values.ctaLabel}
          onChange={(event) => set("ctaLabel", event.target.value)}
          placeholder="mis. Belanja Sekarang"
          maxLength={40}
          required
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-base text-neutral-900">Tujuan tombol</legend>
        <label className="flex min-h-11 items-center gap-2 text-base text-neutral-900">
          <input
            type="radio"
            name="hero-cta-target-type"
            checked={values.ctaTargetType === "anchor"}
            onChange={() => set("ctaTargetType", "anchor")}
          />
          Jangkar di halaman utama
        </label>
        <label className="flex min-h-11 items-center gap-2 text-base text-neutral-900">
          <input
            type="radio"
            name="hero-cta-target-type"
            checked={values.ctaTargetType === "product"}
            onChange={() => set("ctaTargetType", "product")}
          />
          Produk tertentu
        </label>
        {values.ctaTargetType === "product" && (
          <ProductColorPicker
            idPrefix="hero-cta"
            products={products}
            value={values.ctaProduct}
            onChange={(value) => set("ctaProduct", value)}
          />
        )}
      </fieldset>

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
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

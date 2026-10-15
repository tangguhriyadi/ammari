"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Switch, Textarea } from "@ammari/ui";
import type { PublishableProductOption } from "@/lib/content/homepage";
import { saveFeatureBlockDraftAction } from "../actions";
import { ContentImageField, type ContentImageFieldValue } from "./content-image-field";
import { ProductColorPicker, type ProductColorValue } from "./product-color-picker";

export interface FeatureBlockFormValues {
  isVisible: boolean;
  title: string;
  subtitle: string;
  ctaLabel: string;
  linkedProduct: ProductColorValue | null;
  image: ContentImageFieldValue | null;
}

/** Strips client-only `previewUrl` and flattens into contentImageSchema's shape — feature_block
 * never offers a mobile crop in the UI, so `mobile` is always null here, but the shape still
 * carries the (always-null) mobile* fields the shared schema expects. */
function toContentImagePayload(image: ContentImageFieldValue | null) {
  if (!image) return null;
  return {
    storageKey: image.storageKey,
    altText: image.altText,
    width: image.width,
    height: image.height,
    mobileStorageKey: null,
    mobileWidth: null,
    mobileHeight: null,
  };
}

export function FeatureBlockForm({
  initialValues,
  products,
}: {
  initialValues: FeatureBlockFormValues;
  products: PublishableProductOption[];
}) {
  const router = useRouter();
  const [values, setValues] = useState(initialValues);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof FeatureBlockFormValues>(key: K, value: FeatureBlockFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    setFormError(null);
    startTransition(async () => {
      const result = await saveFeatureBlockDraftAction({
        isVisible: values.isVisible,
        content: {
          title: values.title,
          subtitle: values.subtitle,
          ctaLabel: values.ctaLabel,
          linkedProduct: values.linkedProduct ?? { productId: "", fabricColorId: null },
          image: toContentImagePayload(values.image),
        },
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Switch label="Tayang" checked={values.isVisible} onCheckedChange={(checked) => set("isVisible", checked)} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="feature-block-title" required>
          Judul
        </Label>
        <Input id="feature-block-title" value={values.title} onChange={(event) => set("title", event.target.value)} maxLength={100} required />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="feature-block-subtitle" required>
          Subjudul
        </Label>
        <Textarea
          id="feature-block-subtitle"
          value={values.subtitle}
          onChange={(event) => set("subtitle", event.target.value)}
          rows={2}
          maxLength={200}
          required
        />
      </div>

      <ContentImageField
        sectionKey="feature_block"
        label="Gambar feature block"
        value={values.image}
        onChange={(image) => set("image", image)}
        disabled={pending}
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="feature-block-cta-label" required>
          Label tombol
        </Label>
        <Input
          id="feature-block-cta-label"
          value={values.ctaLabel}
          onChange={(event) => set("ctaLabel", event.target.value)}
          maxLength={40}
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-base text-neutral-900">Produk terkait</span>
        <ProductColorPicker idPrefix="feature-block-linked" products={products} value={values.linkedProduct} onChange={(value) => set("linkedProduct", value)} />
      </div>

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

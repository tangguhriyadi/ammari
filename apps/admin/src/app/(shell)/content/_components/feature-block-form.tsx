"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Switch, Textarea } from "@ammari/ui";
import type { PublishableProductOption } from "@/lib/content/homepage";
import { saveFeatureBlockDraftAction } from "../actions";
import { ProductColorPicker, type ProductColorValue } from "./product-color-picker";

export interface FeatureBlockFormValues {
  isVisible: boolean;
  title: string;
  subtitle: string;
  ctaLabel: string;
  linkedProduct: ProductColorValue | null;
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
          image: null,
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

      <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-neutral-300 p-3">
        <span className="text-sm font-medium text-neutral-700">Gambar feature block</span>
        <p className="text-sm text-neutral-600">Unggah gambar akan tersedia di sesi berikutnya.</p>
      </div>

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

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button, ColorSwatch, Input, Label, Switch, useToast } from "@ammari/ui";
import type { PublishableProductOption } from "@/lib/content/homepage";
import { HOMEPAGE_SECTION_LABELS, unpublishedSectionsBannerText } from "@/lib/content/homepage-types";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { publishHomepageAction, saveProductGridDraftAction } from "../actions";
import { ProductColorPicker, type ProductColorValue } from "./product-color-picker";
import { UnpublishedChangesBanner } from "./unpublished-changes-banner";

const SECTION_LABEL = HOMEPAGE_SECTION_LABELS.product_grid;

export interface ProductGridFormValues {
  isVisible: boolean;
  title: string;
  tiles: ProductColorValue[];
}

function resolveTileLabel(tile: ProductColorValue, products: PublishableProductOption[]): { productName: string; colorName: string | null; colorHex: string | null } {
  const product = products.find((candidate) => candidate.id === tile.productId);
  if (!product) return { productName: "Produk tidak ditemukan", colorName: null, colorHex: null };
  const color = tile.fabricColorId ? product.colors.find((candidate) => candidate.id === tile.fabricColorId) : null;
  return { productName: product.name, colorName: color?.name ?? (tile.fabricColorId ? "Warna tidak ditemukan" : "Semua warna"), colorHex: color?.hex ?? null };
}

export function ProductGridForm({
  initialValues,
  products,
  initialUnpublishedSectionLabels,
}: {
  initialValues: ProductGridFormValues;
  products: PublishableProductOption[];
  initialUnpublishedSectionLabels: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState(initialValues);
  const [savedValues, setSavedValues] = useState(initialValues);
  const [unpublishedSectionLabels, setUnpublishedSectionLabels] = useState(initialUnpublishedSectionLabels);
  const [draftTile, setDraftTile] = useState<ProductColorValue | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [publishPending, startPublishTransition] = useTransition();

  const dirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  useUnsavedChangesGuard(dirty);

  function moveTile(index: number, direction: -1 | 1) {
    setValues((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.tiles.length) return prev;
      const next = [...prev.tiles];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return { ...prev, tiles: next };
    });
  }

  function removeTile(index: number) {
    setValues((prev) => ({ ...prev, tiles: prev.tiles.filter((_, candidateIndex) => candidateIndex !== index) }));
  }

  function addTile() {
    if (!draftTile) return;
    setValues((prev) => ({ ...prev, tiles: [...prev.tiles, draftTile] }));
    setDraftTile(null);
  }

  function handleSave() {
    setFormError(null);
    startTransition(async () => {
      const result = await saveProductGridDraftAction({
        isVisible: values.isVisible,
        content: { title: values.title, tiles: values.tiles },
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setSavedValues(values);
      setUnpublishedSectionLabels((prev) => (prev.includes(SECTION_LABEL) ? prev : [...prev, SECTION_LABEL]));
      toast.success("Perubahan berhasil disimpan");
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
      setUnpublishedSectionLabels([]);
      toast.success("Beranda berhasil diterbitkan");
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {unpublishedSectionLabels.length > 0 && (
        <UnpublishedChangesBanner onPublish={handlePublish} pending={publishPending} disabled={dirty} testId="product-grid-unpublished-banner">
          {unpublishedSectionsBannerText(unpublishedSectionLabels)}
        </UnpublishedChangesBanner>
      )}

      <Switch label="Tayang" checked={values.isVisible} onCheckedChange={(checked) => setValues((prev) => ({ ...prev, isVisible: checked }))} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-grid-title" required>
          Judul
        </Label>
        <Input
          id="product-grid-title"
          value={values.title}
          onChange={(event) => setValues((prev) => ({ ...prev, title: event.target.value }))}
          placeholder="mis. Pilihan Favorit"
          maxLength={100}
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-base text-neutral-900">Produk di grid ({values.tiles.length})</span>
        {values.tiles.length === 0 && <p className="text-sm text-neutral-600">Belum ada produk ditambahkan.</p>}
        <ul className="flex flex-col gap-2">
          {values.tiles.map((tile, index) => {
            const label = resolveTileLabel(tile, products);
            return (
              <li key={`${tile.productId}-${tile.fabricColorId ?? "all"}-${index}`} className="flex items-center gap-2 rounded-lg border border-neutral-200 p-2">
                {label.colorHex && <ColorSwatch hex={label.colorHex} />}
                <div className="flex-1">
                  <p className="text-base text-neutral-900">{label.productName}</p>
                  <p className="text-sm text-neutral-600">{label.colorName}</p>
                </div>
                <button
                  type="button"
                  aria-label={`Naikkan urutan ${label.productName}`}
                  onClick={() => moveTile(index, -1)}
                  disabled={index === 0}
                  className="flex size-11 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Turunkan urutan ${label.productName}`}
                  onClick={() => moveTile(index, 1)}
                  disabled={index === values.tiles.length - 1}
                  className="flex size-11 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
                >
                  <ArrowDown className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Hapus ${label.productName} dari grid`}
                  onClick={() => removeTile(index)}
                  className="flex size-11 items-center justify-center rounded-md text-danger-700 hover:bg-danger-50"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3">
        <span className="text-base font-medium text-neutral-900">Tambah produk</span>
        <ProductColorPicker idPrefix="product-grid-add" products={products} value={draftTile} onChange={setDraftTile} />
        <Button type="button" variant="secondary" onClick={addTile} disabled={!draftTile}>
          Tambah ke grid
        </Button>
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

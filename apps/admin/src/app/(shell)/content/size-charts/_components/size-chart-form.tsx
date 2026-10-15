"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label } from "@ammari/ui";
import { CUTTING_SIZES, type CuttingSize } from "@ammari/db/schema";
import { createSizeChartAction, deleteSizeChartAction, updateSizeChartAction } from "../actions";

export interface SizeChartRowValues {
  size: CuttingSize;
  bustCm: string;
  lengthCm: string;
  sleeveLengthCm: string;
  heightRecommendationMinCm: string;
  heightRecommendationMaxCm: string;
}

export interface SizeChartFormValues {
  name: string;
  rows: SizeChartRowValues[];
}

function emptyRows(): SizeChartRowValues[] {
  return CUTTING_SIZES.map((size) => ({
    size,
    bustCm: "",
    lengthCm: "",
    sleeveLengthCm: "",
    heightRecommendationMinCm: "",
    heightRecommendationMaxCm: "",
  }));
}

export function SizeChartForm({
  chartId,
  initialValues,
  productCount = 0,
}: {
  chartId?: string;
  initialValues?: SizeChartFormValues;
  /** Products currently assigned to this chart — shown as a note; the delete action itself is
   * what actually enforces "can't delete while referenced" (the DB's own ON DELETE RESTRICT),
   * this is just the friendly heads-up before someone tries. */
  productCount?: number;
}) {
  const router = useRouter();
  const isCreate = !chartId;
  const [values, setValues] = useState<SizeChartFormValues>(initialValues ?? { name: "", rows: emptyRows() });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();

  function updateRow(size: CuttingSize, patch: Partial<SizeChartRowValues>) {
    setValues((prev) => ({ ...prev, rows: prev.rows.map((row) => (row.size === size ? { ...row, ...patch } : row)) }));
  }

  function handleSubmit() {
    setFormError(null);
    setFieldErrors({});
    startTransition(async () => {
      const payload = {
        name: values.name,
        rows: values.rows.map((row) => ({
          size: row.size,
          bustCm: row.bustCm,
          lengthCm: row.lengthCm,
          sleeveLengthCm: row.sleeveLengthCm,
          heightRecommendationMinCm: row.heightRecommendationMinCm,
          heightRecommendationMaxCm: row.heightRecommendationMaxCm,
        })),
      };
      const result = isCreate ? await createSizeChartAction(payload) : await updateSizeChartAction(chartId, payload);
      if (!result.ok) {
        setFormError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.push(`/content/size-charts/${result.data.id}`);
      router.refresh();
    });
  }

  function handleDelete() {
    if (!chartId) return;
    setFormError(null);
    startDeleteTransition(async () => {
      const result = await deleteSizeChartAction({ id: chartId });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      router.push("/content/size-charts");
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      className="flex max-w-3xl flex-col gap-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="size-chart-name" required>
          Nama size chart
        </Label>
        <Input
          id="size-chart-name"
          value={values.name}
          onChange={(event) => setValues((prev) => ({ ...prev, name: event.target.value }))}
          placeholder="mis. Gamis Reguler"
          error={fieldErrors.name}
          required
        />
      </div>

      <div className="flex flex-col gap-3">
        {values.rows.map((row) => (
          <div key={row.size} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
            <span className="text-base font-semibold text-neutral-900">Ukuran {row.size}</span>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`bust-${row.size}`} required>
                  Lingkar dada (cm)
                </Label>
                <Input
                  id={`bust-${row.size}`}
                  inputMode="numeric"
                  type="number"
                  min={1}
                  value={row.bustCm}
                  onChange={(event) => updateRow(row.size, { bustCm: event.target.value })}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`length-${row.size}`} required>
                  Panjang gamis (cm)
                </Label>
                <Input
                  id={`length-${row.size}`}
                  inputMode="numeric"
                  type="number"
                  min={1}
                  value={row.lengthCm}
                  onChange={(event) => updateRow(row.size, { lengthCm: event.target.value })}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`sleeve-${row.size}`} required>
                  Panjang lengan (cm)
                </Label>
                <Input
                  id={`sleeve-${row.size}`}
                  inputMode="numeric"
                  type="number"
                  min={1}
                  value={row.sleeveLengthCm}
                  onChange={(event) => updateRow(row.size, { sleeveLengthCm: event.target.value })}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label required>Rekomendasi tinggi badan (cm)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Tinggi badan minimum untuk ukuran ${row.size}`}
                    inputMode="numeric"
                    type="number"
                    min={1}
                    value={row.heightRecommendationMinCm}
                    onChange={(event) => updateRow(row.size, { heightRecommendationMinCm: event.target.value })}
                    error={fieldErrors[`height-${row.size}`]}
                    required
                  />
                  <span className="text-neutral-600" aria-hidden="true">
                    –
                  </span>
                  <Input
                    aria-label={`Tinggi badan maksimum untuk ukuran ${row.size}`}
                    inputMode="numeric"
                    type="number"
                    min={1}
                    value={row.heightRecommendationMaxCm}
                    onChange={(event) => updateRow(row.size, { heightRecommendationMaxCm: event.target.value })}
                    required
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        {!isCreate && (
          <>
            {productCount > 0 && (
              <p className="text-sm text-neutral-600">
                Dipakai oleh {productCount} produk — tidak bisa dihapus selama masih dipakai.
              </p>
            )}
            <Button type="button" variant="ghost" onClick={handleDelete} loading={deleting} disabled={productCount > 0}>
              Hapus
            </Button>
          </>
        )}
        <Button type="submit" loading={pending} className="ml-auto">
          Simpan
        </Button>
      </div>
    </form>
  );
}

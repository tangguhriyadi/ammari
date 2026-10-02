"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea, Dialog } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { parseRupiah } from "@/lib/products/money";
import { meterPriceToYardPrice, yardPriceToMeterPrice } from "@/lib/products/fabric-price";
import { createFabricAction, deleteFabricAction, updateFabricAction } from "../actions";
import { createInitialColorRow, NewFabricColorRows, type DraftColorRow } from "./new-fabric-color-rows";

export interface FabricFormValues {
  name: string;
  supplier: string;
  composition: string;
  careInstructions: string;
  notes: string;
  /** The amount+unit as currently stored — the authoritative one on initial load (so an
   * untouched save doesn't re-derive/round anything). */
  priceAmount: string;
  priceUnit: "meter" | "yard" | null;
}

const EMPTY_VALUES: FabricFormValues = {
  name: "",
  supplier: "",
  composition: "",
  careInstructions: "",
  notes: "",
  priceAmount: "",
  priceUnit: null,
};

function formatStoredAmount(raw: string): string {
  const amount = parseRupiah(raw);
  return amount === null ? raw : formatNumber(amount);
}

function displayDerived(initial: FabricFormValues | undefined, unit: "meter" | "yard"): string {
  if (!initial || initial.priceUnit === null) return "";
  const amount = parseRupiah(initial.priceAmount);
  if (amount === null) return "";
  const derived = unit === "meter" ? yardPriceToMeterPrice(amount) : meterPriceToYardPrice(amount);
  return derived === null ? "" : formatNumber(derived);
}

export function FabricForm({
  fabricId,
  initialValues,
  productCount = 0,
}: {
  fabricId?: string;
  initialValues?: FabricFormValues;
  productCount?: number;
}) {
  const router = useRouter();
  const [values, setValues] = useState<FabricFormValues>(initialValues ?? EMPTY_VALUES);
  // The two displayed price text fields — kept as plain editable text, not re-derived from
  // `values` on every render, so the user can keep typing (including transient invalid states
  // like "92." mid-edit) without the other field fighting back.
  const [meterPrice, setMeterPrice] = useState(() =>
    initialValues?.priceUnit === "meter" ? formatStoredAmount(initialValues.priceAmount) : displayDerived(initialValues, "meter"),
  );
  const [yardPrice, setYardPrice] = useState(() =>
    initialValues?.priceUnit === "yard" ? formatStoredAmount(initialValues.priceAmount) : displayDerived(initialValues, "yard"),
  );
  const [priceUnit, setPriceUnit] = useState<"meter" | "yard" | null>(initialValues?.priceUnit ?? null);
  // Only meaningful in create mode (no fabricId yet) — once a fabric exists, its colors are
  // managed by FabricColorsSection on the detail page instead (see the parent page components).
  const [colorRows, setColorRows] = useState<DraftColorRow[]>(() => (fabricId ? [] : [createInitialColorRow()]));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof FabricFormValues>(key: K, value: FabricFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  // Server-returned field errors are keyed `colors.<index>.<field>` — tied to each row's position
  // AT THE TIME OF SUBMISSION. Adding/removing a row afterward shifts every later row's index, so
  // a stale error would otherwise point at the wrong row (or, worse, collide with an unrelated
  // one). Any row mutation clears all `colors.*` errors rather than trying to remap them.
  function handleColorRowsChange(next: DraftColorRow[]) {
    setColorRows(next);
    setFieldErrors((prev) => {
      if (!Object.keys(prev).some((key) => key.startsWith("colors."))) return prev;
      const entries = Object.entries(prev).filter(([key]) => !key.startsWith("colors."));
      return Object.fromEntries(entries);
    });
  }

  function handleMeterChange(raw: string) {
    setMeterPrice(raw);
    if (raw.trim() === "") {
      setYardPrice("");
      setPriceUnit(null);
      return;
    }
    const parsed = parseRupiah(raw);
    setPriceUnit("meter");
    if (parsed !== null) {
      const derived = meterPriceToYardPrice(parsed);
      setYardPrice(derived === null ? "" : formatNumber(derived));
    }
  }

  function handleYardChange(raw: string) {
    setYardPrice(raw);
    if (raw.trim() === "") {
      setMeterPrice("");
      setPriceUnit(null);
      return;
    }
    const parsed = parseRupiah(raw);
    setPriceUnit("yard");
    if (parsed !== null) {
      const derived = yardPriceToMeterPrice(parsed);
      setMeterPrice(derived === null ? "" : formatNumber(derived));
    }
  }

  function handleSubmit() {
    setFormError(null);
    setFieldErrors({});
    startTransition(async () => {
      const authoritativePrice = priceUnit === "yard" ? yardPrice : meterPrice;
      const input = {
        name: values.name,
        supplier: values.supplier || undefined,
        composition: values.composition || undefined,
        priceAmount: priceUnit ? authoritativePrice : "",
        priceUnit: priceUnit ?? undefined,
        careInstructions: values.careInstructions || undefined,
        notes: values.notes || undefined,
      };
      if (fabricId) {
        const result = await updateFabricAction(fabricId, input);
        if (!result.ok) {
          setFormError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
          return;
        }
        router.push("/bahan");
        router.refresh();
        return;
      }
      const result = await createFabricAction({
        ...input,
        colors: colorRows.map((row) => ({
          name: row.name,
          supplierColorCode: row.supplierColorCode || undefined,
          hex: row.hex || undefined,
        })),
      });
      if (!result.ok) {
        setFormError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.push(`/bahan/${result.data.id}`);
      router.refresh();
    });
  }

  function handleDelete() {
    if (!fabricId) return;
    startTransition(async () => {
      const result = await deleteFabricAction(fabricId);
      setConfirmDeleteOpen(false);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      router.push("/bahan");
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      className="flex max-w-xl flex-col gap-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fabric-name" required>
          Nama bahan
        </Label>
        <Input
          id="fabric-name"
          value={values.name}
          onChange={(event) => set("name", event.target.value)}
          placeholder="mis. Poka"
          error={fieldErrors.name}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fabric-supplier">Pemasok</Label>
        <Input
          id="fabric-supplier"
          value={values.supplier}
          onChange={(event) => set("supplier", event.target.value)}
          placeholder="mis. Laksmi, Pasar Baru"
          error={fieldErrors.supplier}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fabric-composition">Komposisi</Label>
        <Input
          id="fabric-composition"
          value={values.composition}
          onChange={(event) => set("composition", event.target.value)}
          placeholder="mis. polyester + rayon"
          error={fieldErrors.composition}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fabric-price-meter">Harga per meter</Label>
          <Input
            id="fabric-price-meter"
            inputMode="numeric"
            value={meterPrice}
            onChange={(event) => handleMeterChange(event.target.value)}
            placeholder="mis. 85.000"
            error={priceUnit !== "yard" ? fieldErrors.priceAmount : undefined}
          />
          {priceUnit === "yard" && <p className="text-sm text-neutral-600">≈ dihitung dari harga per yard</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fabric-price-yard">Harga per yard</Label>
          <Input
            id="fabric-price-yard"
            inputMode="numeric"
            value={yardPrice}
            onChange={(event) => handleYardChange(event.target.value)}
            placeholder="mis. 77.724"
            error={priceUnit === "yard" ? fieldErrors.priceAmount : undefined}
          />
          {priceUnit === "meter" && <p className="text-sm text-neutral-600">≈ dihitung dari harga per meter</p>}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fabric-care">Panduan Perawatan</Label>
        <Textarea
          id="fabric-care"
          value={values.careInstructions}
          onChange={(event) => set("careInstructions", event.target.value)}
          error={fieldErrors.careInstructions}
          rows={4}
        />
        <p className="text-sm text-neutral-600">Akan ditampilkan di halaman katalog.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fabric-notes">Catatan</Label>
        <Textarea id="fabric-notes" value={values.notes} onChange={(event) => set("notes", event.target.value)} error={fieldErrors.notes} />
      </div>

      {!fabricId && <NewFabricColorRows rows={colorRows} onChange={handleColorRowsChange} fieldErrors={fieldErrors} disabled={pending} />}

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" loading={pending}>
          Simpan
        </Button>
        {fabricId && (
          <Button type="button" variant="danger" onClick={() => setConfirmDeleteOpen(true)} disabled={pending}>
            Hapus
          </Button>
        )}
      </div>

      {fabricId && (
        <Dialog
          open={confirmDeleteOpen}
          onOpenChange={setConfirmDeleteOpen}
          title="Hapus bahan ini?"
          description={
            productCount > 0
              ? `Bahan ini masih dipakai oleh ${productCount} produk, tidak bisa dihapus.`
              : "Tindakan ini tidak bisa dibatalkan."
          }
          confirmLabel="Hapus"
          confirmVariant="danger"
          onConfirm={productCount > 0 ? undefined : handleDelete}
          loading={pending}
        />
      )}
    </form>
  );
}

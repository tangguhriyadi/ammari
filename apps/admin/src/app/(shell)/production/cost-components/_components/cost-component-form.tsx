"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Select, Switch, useToast } from "@ammari/ui";
import { COST_COMPONENT_TYPES, COST_COMPONENT_UNITS, type CostComponentType, type CostComponentUnit } from "@ammari/db/schema";
import type { SupplierOption } from "@/lib/suppliers/queries";
import { createCostComponentAction, updateCostComponentAction } from "../actions";
import { SupplierSelect, type CurrentSupplier } from "../../_components/supplier-select";

const UNIT_LABELS: Record<CostComponentUnit, string> = {
  pcs: "Pcs",
  meter: "Meter",
  yard: "Yard",
  lusin: "Lusin",
  set: "Set",
};

const COST_TYPE_LABELS: Record<CostComponentType, string> = {
  variable: "Variabel (per pcs)",
  fixed: "Tetap (per batch)",
};

interface CostComponentFormValues {
  name: string;
  unit: CostComponentUnit;
  defaultUnitPrice: string;
  costType: CostComponentType;
  isActive: boolean;
  sortOrder: number;
  /** "" for none. */
  defaultSupplierId: string;
}

// A discriminated union, not an optional `componentId?` — "edit" always has a real id to submit
// to, enforced by the compiler rather than a `componentId!` non-null assertion at the one call
// site that needs it (same reasoning as ProductionBatchFormProps).
interface CostComponentFormCommonProps {
  initialValues: CostComponentFormValues;
  /** Active suppliers only, "Jasa (penjahit)" first — see listActiveSupplierOptions. */
  supplierOptions: SupplierOption[];
}

export type CostComponentFormProps =
  | ({ mode: "create" } & CostComponentFormCommonProps)
  | ({
      mode: "edit";
      componentId: string;
      /** The saved default supplier, so a since-deactivated one still shows as the value. */
      currentSupplier: CurrentSupplier | null;
    } & CostComponentFormCommonProps);

export function CostComponentForm(props: CostComponentFormProps) {
  const { initialValues, supplierOptions } = props;
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(initialValues.name);
  const [unit, setUnit] = useState<CostComponentUnit>(initialValues.unit);
  const [costType, setCostType] = useState<CostComponentType>(initialValues.costType);
  const [defaultUnitPrice, setDefaultUnitPrice] = useState(initialValues.defaultUnitPrice);
  const [isActive, setIsActive] = useState(initialValues.isActive);
  const [defaultSupplierId, setDefaultSupplierId] = useState(initialValues.defaultSupplierId);
  // Not user-editable — the "Urutan tampil" field is hidden from this form, so this just
  // carries the existing value (or 0 for a new component) straight through to the payload.
  const sortOrder = String(initialValues.sortOrder);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const payload = {
        name,
        unit,
        defaultUnitPrice,
        costType,
        isActive,
        sortOrder: Number.parseInt(sortOrder, 10) || 0,
        defaultSupplierId: defaultSupplierId || null,
      };
      const result =
        props.mode === "create" ? await createCostComponentAction(payload) : await updateCostComponentAction(props.componentId, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(props.mode === "create" ? "Komponen biaya berhasil ditambahkan" : "Perubahan berhasil disimpan");
      router.push("/production/cost-components");
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div>
        <Label htmlFor="component-name" required>
          Nama komponen
        </Label>
        <Input id="component-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div>
        <Label htmlFor="component-cost-type" required>
          Jenis biaya
        </Label>
        <Select
          id="component-cost-type"
          value={costType}
          onChange={(event) => {
            const nextCostType = event.target.value as CostComponentType;
            setCostType(nextCostType);
            // "Tetap (per batch)" has no meaningful per-unit quantity — the unit field is
            // hidden for it, so it's forced to 'set' rather than left at whatever the operator
            // last picked while on "Variabel (per pcs)".
            if (nextCostType === "fixed") setUnit("set");
          }}
        >
          {COST_COMPONENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {COST_TYPE_LABELS[value]}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {costType !== "fixed" && (
          <div>
            <Label htmlFor="component-unit" required>
              Satuan
            </Label>
            <Select id="component-unit" value={unit} onChange={(event) => setUnit(event.target.value as CostComponentUnit)}>
              {COST_COMPONENT_UNITS.map((value) => (
                <option key={value} value={value}>
                  {UNIT_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label htmlFor="component-price">{costType === "fixed" ? "Nominal default" : "Harga default per pcs"}</Label>
          <Input
            id="component-price"
            value={defaultUnitPrice}
            onChange={(event) => setDefaultUnitPrice(event.target.value)}
            placeholder="Opsional"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="component-supplier">Supplier</Label>
        <SupplierSelect
          id="component-supplier"
          value={defaultSupplierId}
          onChange={setDefaultSupplierId}
          options={supplierOptions}
          current={props.mode === "edit" ? props.currentSupplier : null}
        />
        <p className="mt-1 text-sm text-neutral-600">Otomatis terisi saat komponen ini ditambahkan ke batch produksi. Bisa diganti per batch.</p>
      </div>
      <Switch checked={isActive} onCheckedChange={setIsActive} label="Aktif" />

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {props.mode === "create" && (
          <Link href="/production/cost-components">
            <Button type="button" variant="secondary">
              Batal
            </Button>
          </Link>
        )}
        <Button type="submit" loading={saving}>
          Simpan
        </Button>
      </div>
    </form>
  );
}

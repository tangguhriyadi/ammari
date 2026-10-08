"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Select, Switch } from "@ammari/ui";
import { COST_COMPONENT_TYPES, COST_COMPONENT_UNITS, type CostComponentType, type CostComponentUnit } from "@ammari/db/schema";
import { createCostComponentAction, updateCostComponentAction } from "../actions";

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
}

// A discriminated union, not an optional `componentId?` — "edit" always has a real id to submit
// to, enforced by the compiler rather than a `componentId!` non-null assertion at the one call
// site that needs it (same reasoning as ProductionBatchFormProps).
export type CostComponentFormProps =
  | { mode: "create"; initialValues: CostComponentFormValues }
  | { mode: "edit"; componentId: string; initialValues: CostComponentFormValues };

export function CostComponentForm(props: CostComponentFormProps) {
  const { initialValues } = props;
  const router = useRouter();
  const [name, setName] = useState(initialValues.name);
  const [unit, setUnit] = useState<CostComponentUnit>(initialValues.unit);
  const [costType, setCostType] = useState<CostComponentType>(initialValues.costType);
  const [defaultUnitPrice, setDefaultUnitPrice] = useState(initialValues.defaultUnitPrice);
  const [isActive, setIsActive] = useState(initialValues.isActive);
  // Not user-editable — the "Urutan tampil" field is hidden from this form, so this just
  // carries the existing value (or 0 for a new component) straight through to the payload.
  const sortOrder = String(initialValues.sortOrder);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const payload = { name, unit, defaultUnitPrice, costType, isActive, sortOrder: Number.parseInt(sortOrder, 10) || 0 };
      const result =
        props.mode === "create" ? await createCostComponentAction(payload) : await updateCostComponentAction(props.componentId, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
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
      <Switch checked={isActive} onCheckedChange={setIsActive} label="Aktif" />

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={saving}>
          Simpan
        </Button>
      </div>
    </form>
  );
}

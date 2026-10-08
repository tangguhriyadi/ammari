"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button, Input, Label, Select, Switch, Textarea } from "@ammari/ui";
import { SIZES, type Size } from "@ammari/db/schema";
import { createAccessoryAction, listDistinctSizeGroupsAction, updateAccessoryAction } from "../actions";

const SIZE_LABELS: Record<Size, string> = {
  XS: "XS",
  S: "S",
  M: "M",
  L: "L",
  XL: "XL",
  ALLSIZE: "Polos (semua ukuran)",
};

interface AccessoryFormValues {
  name: string;
  size: Size | "";
  sizeGroup: string;
  isActive: boolean;
  notes: string;
}

// Discriminated union, not an optional `accessoryId?` — same reasoning
// ProductionBatchFormProps/CostComponentFormProps already use (see those files): "edit" always
// has a real id to submit to, enforced by the compiler instead of an `accessoryId!` assertion.
export type AccessoryFormProps =
  | { mode: "create"; initialValues: AccessoryFormValues }
  | { mode: "edit"; accessoryId: string; initialValues: AccessoryFormValues };

export function AccessoryForm(props: AccessoryFormProps) {
  const { initialValues } = props;
  const router = useRouter();
  const [name, setName] = useState(initialValues.name);
  const [size, setSize] = useState<Size | "">(initialValues.size);
  const [sizeGroup, setSizeGroup] = useState(initialValues.sizeGroup);
  const [isActive, setIsActive] = useState(initialValues.isActive);
  const [notes, setNotes] = useState(initialValues.notes);
  const [existingGroups, setExistingGroups] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  // Fetched once on mount, not synced with any later state — a brand-new group typed into this
  // very form doesn't need to appear in its OWN datalist mid-edit.
  useEffect(() => {
    listDistinctSizeGroupsAction().then(setExistingGroups).catch(() => setExistingGroups([]));
  }, []);

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const payload = { name, size: size || undefined, sizeGroup: sizeGroup || undefined, isActive, notes: notes || undefined };
      const result = props.mode === "create" ? await createAccessoryAction(payload) : await updateAccessoryAction(props.accessoryId, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/accessories/${result.data.id}`);
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
        <Label htmlFor="accessory-name" required>
          Nama aksesoris
        </Label>
        <Input id="accessory-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="accessory-size">Ukuran</Label>
          <Select id="accessory-size" value={size} onChange={(event) => setSize(event.target.value as Size | "")}>
            <option value="">Tidak ada</option>
            {SIZES.map((value) => (
              <option key={value} value={value}>
                {SIZE_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="accessory-size-group">Grup ukuran</Label>
          {/* Native input+datalist, not a new component — offers existing groups while still
              accepting a new one typed freely. size_group is citext at the DB level, so a
              case-only variant of an existing group still collides correctly even if the owner
              types instead of picking from the list (correction #4, approved plan). */}
          <Input
            id="accessory-size-group"
            list="accessory-size-group-options"
            value={sizeGroup}
            onChange={(event) => setSizeGroup(event.target.value)}
            placeholder="contoh: Label Ammari"
          />
          <datalist id="accessory-size-group-options">
            {existingGroups.map((group) => (
              <option key={group} value={group} />
            ))}
          </datalist>
        </div>
      </div>
      <div>
        <Label htmlFor="accessory-notes">Catatan</Label>
        <Textarea id="accessory-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
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

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label } from "@ammari/ui";
import {
  createFabricColorAction,
  deleteFabricColorAction,
  setFabricColorActiveAction,
  updateFabricColorAction,
} from "../actions";

export interface FabricColorRow {
  id: string;
  name: string;
  supplierColorCode: string | null;
  hex: string | null;
  isActive: boolean;
}

function Swatch({ hex }: { hex: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-6 shrink-0 rounded-full border border-neutral-300"
      style={{ backgroundColor: hex ?? undefined }}
    />
  );
}

function ColorRow({ color, usageCount }: { color: FabricColorRow; usageCount: number }) {
  const router = useRouter();
  const [name, setName] = useState(color.name);
  const [supplierColorCode, setSupplierColorCode] = useState(color.supplierColorCode ?? "");
  const [hex, setHex] = useState(color.hex ?? "#9CA3AF");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updateFabricColorAction(color.id, {
        name,
        supplierColorCode: supplierColorCode || undefined,
        hex,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function toggleActive() {
    setError(null);
    startTransition(async () => {
      const result = await setFabricColorActiveAction({ id: color.id, isActive: !color.isActive });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteFabricColorAction(color.id);
      setConfirmDeleteOpen(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 border-b border-neutral-100 py-3 last:border-0 sm:flex-row sm:items-center sm:gap-3">
      <Swatch hex={hex} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        className="flex flex-1 flex-wrap items-center gap-2"
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Nama warna"
          className="w-36"
          disabled={pending}
        />
        <Input
          value={supplierColorCode}
          onChange={(event) => setSupplierColorCode(event.target.value)}
          aria-label="Kode warna pemasok"
          placeholder="Kode pemasok"
          className="w-32"
          disabled={pending}
        />
        <input
          type="color"
          aria-label="Kode warna"
          value={hex}
          onChange={(event) => setHex(event.target.value)}
          disabled={pending}
          className="size-11 shrink-0 rounded border border-neutral-500"
        />
        <Badge variant={color.isActive ? "success" : "neutral"}>{color.isActive ? "Aktif" : "Nonaktif"}</Badge>
        <Button type="submit" variant="secondary" loading={pending}>
          Simpan
        </Button>
        <Button type="button" variant={color.isActive ? "danger" : "secondary"} onClick={toggleActive} disabled={pending}>
          {color.isActive ? "Nonaktifkan" : "Aktifkan"}
        </Button>
        <Button type="button" variant="danger" onClick={() => setConfirmDeleteOpen(true)} disabled={pending}>
          Hapus
        </Button>
      </form>
      {error && (
        <span role="alert" className="text-sm text-danger-700">
          {error}
        </span>
      )}

      <Dialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Hapus warna ini?"
        description={
          usageCount > 0
            ? `Warna ini masih dipakai oleh ${usageCount} varian, tidak bisa dihapus.`
            : "Tindakan ini tidak bisa dibatalkan."
        }
        confirmLabel="Hapus"
        confirmVariant="danger"
        onConfirm={usageCount > 0 ? undefined : handleDelete}
        loading={pending}
      />
    </li>
  );
}

function AddColorForm({ fabricId }: { fabricId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [supplierColorCode, setSupplierColorCode] = useState("");
  const [hex, setHex] = useState("#9CA3AF");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createFabricColorAction(fabricId, {
        name,
        supplierColorCode: supplierColorCode || undefined,
        hex,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setSupplierColorCode("");
      setHex("#9CA3AF");
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-300 p-4"
    >
      <p className="text-base font-semibold text-neutral-900">Tambah warna</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-fabric-color-name">Nama warna</Label>
          <Input id="new-fabric-color-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="mis. Sage" disabled={pending} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-fabric-color-supplier-code">Kode pemasok (opsional)</Label>
          <Input
            id="new-fabric-color-supplier-code"
            value={supplierColorCode}
            onChange={(event) => setSupplierColorCode(event.target.value)}
            placeholder="mis. No. 23"
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-fabric-color-hex">Kode warna</Label>
          <input
            id="new-fabric-color-hex"
            type="color"
            value={hex}
            onChange={(event) => setHex(event.target.value)}
            disabled={pending}
            className="size-11 rounded border border-neutral-500"
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Button type="submit" loading={pending} disabled={!name.trim()}>
        Tambah warna
      </Button>
    </form>
  );
}

export function FabricColorsSection({
  fabricId,
  colors,
  usageCounts,
}: {
  fabricId: string;
  colors: FabricColorRow[];
  usageCounts: Record<string, number>;
}) {
  return (
    <div className="flex flex-col gap-4">
      {colors.length > 0 ? (
        <ul className="rounded-lg border border-neutral-200 px-4">
          {colors.map((color) => (
            // Keyed on the server-derived values (not just id) so a router.refresh() that
            // changes a color's canonical data (e.g. a concurrent edit in another tab) remounts
            // this row and resyncs its local input state instead of leaving stale values behind —
            // same hazard and fix as VariantRowEditor in variant-builder.tsx.
            <ColorRow
              key={`${color.id}:${color.name}:${color.hex}:${color.supplierColorCode}`}
              color={color}
              usageCount={usageCounts[color.id] ?? 0}
            />
          ))}
        </ul>
      ) : (
        <p className="text-base text-neutral-600">Belum ada warna untuk bahan ini.</p>
      )}
      <AddColorForm fabricId={fabricId} />
    </div>
  );
}

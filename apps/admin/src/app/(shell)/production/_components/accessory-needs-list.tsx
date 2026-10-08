"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Input, Label } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import type { AccessoryNeedRow } from "@/lib/production/accessory-needs";
import { setAccessoryOverrideAction } from "../actions";

export function AccessoryNeedsList({ batchId, rows }: { batchId: string; rows: AccessoryNeedRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <AccessoryNeedRowItem key={row.accessoryId} batchId={batchId} row={row} />
      ))}
    </div>
  );
}

function AccessoryNeedRowItem({ batchId, row }: { batchId: string; row: AccessoryNeedRow }) {
  const router = useRouter();
  const [overrideText, setOverrideText] = useState(row.overrideQty !== null ? String(row.overrideQty) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    const trimmed = overrideText.trim();
    if (trimmed === "") {
      startTransition(async () => {
        const result = await setAccessoryOverrideAction({ batchId, accessoryId: row.accessoryId, overrideQty: null });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== trimmed || parsed < 0) {
      setError("Jumlah override harus bilangan bulat dan tidak boleh negatif.");
      return;
    }
    startTransition(async () => {
      const result = await setAccessoryOverrideAction({ batchId, accessoryId: row.accessoryId, overrideQty: parsed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
      <div className="flex-1">
        <p className="text-base text-neutral-900">{row.accessoryName}</p>
        <p className="text-sm text-neutral-600">
          Butuh {formatNumber(row.computedQty)} pcs · Stok {formatNumber(row.currentStock)} pcs
          {row.overrideQty !== null && ` · Override aktif: ${formatNumber(row.overrideQty)} pcs`}
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-end gap-2">
        {row.shortage && <Badge variant="danger">Stok kurang</Badge>}
        <div className="w-28">
          <Label htmlFor={`accessory-override-${row.accessoryId}`} className="sr-only">
            Override jumlah untuk {row.accessoryName}
          </Label>
          <Input
            id={`accessory-override-${row.accessoryId}`}
            inputMode="numeric"
            value={overrideText}
            onChange={(event) => setOverrideText(event.target.value)}
            placeholder={String(row.computedQty)}
          />
        </div>
        <Button type="button" variant="secondary" onClick={handleSave} loading={pending}>
          Simpan
        </Button>
      </div>
    </div>
  );
}

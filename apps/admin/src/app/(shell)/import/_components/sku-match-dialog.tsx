"use client";

import { useId, useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label } from "@ammari/ui";
import { sizeLabel } from "@ammari/commerce/size-label";
import type { UnknownSkuGroup } from "@/lib/marketplace-import/plan";
import type { MatchVariantOption } from "@/lib/marketplace-import/variant-search";
import { searchMatchVariantsAction } from "../actions";

// "Cocokkan ke varian" (docs/plans/marketplace-import.md §8.1): pick the admin variant an unknown
// file SKU stands for, for this import only. A person searches; nothing is matched by name
// automatically. The server re-validates the pick on every Periksa file / Simpan.

export interface SkuMatchDialogProps {
  group: UnknownSkuGroup | null;
  onClose: () => void;
  onPick: (fileSku: string, adminSku: string) => void;
}

/** Rendered with `key={fileSku}` by the caller, so each SKU starts with an empty search. */
export function SkuMatchDialog({ group, onClose, onPick }: SkuMatchDialogProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MatchVariantOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function search() {
    const q = query.trim();
    if (q.length < 2) {
      setError("Ketik minimal 2 huruf.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        setResults(await searchMatchVariantsAction(q));
      } catch (caught) {
        console.error("[import] variant search failed to reach the server", caught);
        setError("Pencarian gagal. Coba lagi.");
      }
    });
  }

  return (
    <Dialog
      open={group !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Cocokkan ke varian"
      description={group?.fileSku ? `SKU di file: ${group.fileSku}. Berlaku untuk impor ini saja.` : undefined}
      cancelLabel="Tutup"
    >
      <div className="flex flex-col gap-3">
        {group && group.nameHints.length > 0 && <p className="text-sm text-neutral-600">Nama di file: {group.nameHints.join(", ")}</p>}
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor={searchId}>Cari varian admin</Label>
            <Input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Produk, kode, warna atau SKU" autoComplete="off" error={error ?? undefined} />
          </div>
          <Button type="submit" variant="secondary" loading={pending}>
            Cari
          </Button>
        </form>
        {results !== null && results.length === 0 && <p className="text-sm text-neutral-600">Tidak ada varian yang cocok.</p>}
        {results !== null && results.length > 0 && (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label="Hasil pencarian varian">
            {results.map((option) => (
              <li key={option.sku} className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 p-2">
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-neutral-900">
                    {option.productName} <span className="font-normal text-neutral-600">{option.colorName} · {sizeLabel(option.size)}</span>
                  </span>
                  <span className="font-mono text-sm break-all text-neutral-700">{option.sku}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!option.isActive && <Badge>Nonaktif</Badge>}
                  <Button type="button" onClick={() => group?.fileSku && onPick(group.fileSku, option.sku)} aria-label={`Pilih ${option.sku}`}>
                    Pilih
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

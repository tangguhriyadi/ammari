"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Checkbox, ColorSwatch, Input, Label, Switch } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { Size, SizeMode } from "@ammari/db/schema";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { addVariantsAction, bulkUpdateVariantsAction, setVariantActiveAction } from "../actions";

export interface VariantRow {
  sku: string;
  colorName: string;
  colorHex: string | null;
  size: string;
  priceOverrideAmount: number | null;
  minStockQty: number;
  isActive: boolean;
}

export interface AvailableColor {
  id: string;
  name: string;
  hex: string | null;
}

const SIZED_SIZES = ["XS", "S", "M", "L", "XL"] as const;

function CopySkuButton({ sku }: { sku: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(resetTimeoutRef.current);
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(sku);
      setCopied(true);
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (insecure context, permission denied) — a silent no-op;
      // the SKU is still fully visible as plain selectable text either way.
    }
  }

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Salin SKU"
        className="flex size-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {copied ? <Check className="size-3.5 text-success-700" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
      {copied && (
        <span role="status" className="absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap text-xs text-success-700">
          Tersalin
        </span>
      )}
    </span>
  );
}

/** Toggling "Aktif" keeps saving immediately (unlike price/stock, which stage into the group's
 * "Simpan perubahan"). Presentational only — pending/error live in VariantColorGroup, keyed by
 * sku, so the desktop table cell and the mobile card for the SAME row share one source of truth
 * instead of each independently tracking their own (both are always mounted, one hidden via CSS
 * per breakpoint, so two un-synced internal states would let a toggle in flight from the visible
 * layout show as idle in the other until the next refresh). `accessibleLabel` disambiguates the
 * switch for assistive tech without visually repeating "untuk ukuran X" next to every row — the
 * table's "Aktif" column header (and the size shown earlier in the same row/card) already gives
 * sighted users that context. */
function VariantActiveSwitch({
  size,
  isActive,
  pending,
  error,
  onToggle,
}: {
  size: string;
  isActive: boolean;
  pending: boolean;
  error?: string;
  onToggle: () => void;
}) {
  return (
    <Switch
      label="Aktif"
      accessibleLabel={`Aktif untuk ukuran ${size}`}
      checked={isActive}
      onCheckedChange={onToggle}
      pending={pending}
      error={error}
    />
  );
}

function BulkFillMinStock({ onFill, disabled }: { onFill: (value: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("0");

  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label="Nilai stok minimum untuk semua ukuran di warna ini"
        inputMode="numeric"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        className="h-8 min-h-0 w-16 px-2 text-right text-sm"
      />
      <button
        type="button"
        onClick={() => onFill(value)}
        disabled={disabled}
        className="text-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:text-neutral-400 disabled:no-underline"
      >
        Isi stok minimum
      </button>
    </div>
  );
}

type EditedFields = { priceOverride?: string; minStock?: string };

/** One color group's variant rows — a real table at >= 640px, compact cards below it. Price and
 * min-stock edits are staged locally (not saved per keystroke or per row) until "Simpan
 * perubahan" sends every changed row in one atomic call; "Aktif" keeps saving immediately via
 * VariantActiveSwitch above. */
function VariantColorGroup({
  productId,
  colorName,
  colorHex,
  rows,
  basePrice,
}: {
  productId: string;
  colorName: string;
  colorHex: string | null;
  rows: VariantRow[];
  basePrice: number;
}) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, EditedFields>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  // "Aktif" toggles save immediately (unlike price/stock) and need their OWN pending/error per
  // row, shared between the row's desktop table cell and mobile card — see VariantActiveSwitch's
  // doc comment for why this can't be local state inside that component.
  const [togglePending, setTogglePending] = useState<Record<string, boolean>>({});
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});

  const isDirty = Object.keys(edits).length > 0;
  useUnsavedChangesGuard(isDirty, "Ada perubahan harga/stok yang belum disimpan. Tinggalkan halaman ini?");

  // Drops any staged edit whose row no longer belongs to this group — e.g. toggling a row's own
  // "Aktif" moves it to the other (active/inactive) bucket, which is a SEPARATE VariantColorGroup
  // instance; this one keeps its local `edits` state (same `${colorName}:${colorHex}` key across
  // the refresh) but the row itself vanishes from `rows`. Without this, a stale `edits` entry for
  // a sku no longer in `rows` would crash `save()` and silently block the group's "Simpan
  // perubahan" forever with no error shown (react-review finding). Adjusted during render
  // (React's documented "adjust state when a prop changes" pattern — see photo-tile.tsx's
  // `syncedAltText` for the same convention elsewhere in this app), not a useEffect, so a stale
  // edit can never survive a single extra render pass.
  const rowSkuKey = rows.map((row) => row.sku).join(",");
  const [prevRowSkuKey, setPrevRowSkuKey] = useState(rowSkuKey);
  if (rowSkuKey !== prevRowSkuKey) {
    setPrevRowSkuKey(rowSkuKey);
    const validSkus = new Set(rowSkuKey ? rowSkuKey.split(",") : []);
    setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([sku]) => validSkus.has(sku))));
    setFieldErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => validSkus.has(key.split(":")[0] ?? ""))));
  }

  function effectivePrice(row: VariantRow): string {
    return edits[row.sku]?.priceOverride ?? (row.priceOverrideAmount != null ? String(row.priceOverrideAmount) : "");
  }

  function effectiveMinStock(row: VariantRow): string {
    return edits[row.sku]?.minStock ?? String(row.minStockQty);
  }

  /** Writes one field's edit for `sku`, but DROPS it instead when `value` matches the row's
   * original — so retyping back to the starting value un-dirties that field (and the whole row,
   * once both fields match) rather than leaving a no-op edit staged forever. */
  function setFieldEdit(sku: string, field: keyof EditedFields, value: string, original: string) {
    setEdits((prev) => {
      const current = { ...prev[sku] };
      if (value === original) {
        delete current[field];
      } else {
        current[field] = value;
      }
      const next = { ...prev };
      if (Object.keys(current).length === 0) {
        delete next[sku];
      } else {
        next[sku] = current;
      }
      return next;
    });
  }

  function changePrice(row: VariantRow, value: string) {
    setFieldEdit(row.sku, "priceOverride", value, row.priceOverrideAmount != null ? String(row.priceOverrideAmount) : "");
  }

  function changeMinStock(row: VariantRow, value: string) {
    setFieldEdit(row.sku, "minStock", value, String(row.minStockQty));
  }

  function fillMinStock(value: string) {
    for (const row of rows) {
      setFieldEdit(row.sku, "minStock", value, String(row.minStockQty));
    }
  }

  function toggleActive(row: VariantRow) {
    setToggleErrors((prev) => {
      if (!(row.sku in prev)) return prev;
      const next = { ...prev };
      delete next[row.sku];
      return next;
    });
    setTogglePending((prev) => ({ ...prev, [row.sku]: true }));
    (async () => {
      const result = await setVariantActiveAction({ sku: row.sku, isActive: !row.isActive });
      setTogglePending((prev) => ({ ...prev, [row.sku]: false }));
      if (!result.ok) {
        setToggleErrors((prev) => ({ ...prev, [row.sku]: result.error }));
        return;
      }
      router.refresh();
    })();
  }

  function discard() {
    setEdits({});
    setFieldErrors({});
    setFormError(null);
  }

  function save() {
    // Filtered against the CURRENT rows, not asserted — a dirty sku can briefly reference a row
    // that just left this group (see the pruning effect above); this guards the same case in
    // case the effect hasn't re-run yet by the time the user clicks Save.
    const dirtySkus = Object.keys(edits).filter((sku) => rows.some((row) => row.sku === sku));
    if (dirtySkus.length === 0) return;
    setFieldErrors({});
    setFormError(null);
    startTransition(async () => {
      const updates = dirtySkus.map((sku) => {
        const row = rows.find((candidate) => candidate.sku === sku)!;
        return {
          sku,
          priceOverrideAmount: edits[sku]?.priceOverride ?? (row.priceOverrideAmount != null ? String(row.priceOverrideAmount) : ""),
          minStockQty: edits[sku]?.minStock ?? String(row.minStockQty),
        };
      });
      const result = await bulkUpdateVariantsAction({ productId, updates });
      if (!result.ok) {
        if (result.fieldErrors) {
          setFieldErrors(result.fieldErrors);
        } else {
          setFormError(result.error);
        }
        return;
      }
      setEdits({});
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ColorSwatch hex={colorHex} className="size-4" />
          <h3 className="text-base font-semibold text-neutral-900">{colorName}</h3>
        </div>
        <BulkFillMinStock onFill={fillMinStock} disabled={saving} />
      </div>
      <p className="mb-3 text-sm text-neutral-600">Harga khusus kosong = harga dasar {formatRupiah(basePrice)}.</p>

      {/* Desktop/tablet: a real table — one header row, columns aligned across every row. */}
      <div className="hidden overflow-x-auto rounded-md border border-neutral-200 sm:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-xs text-neutral-600">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Ukuran
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                SKU
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Harga khusus
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Stok minimum
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Aktif
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.sku} className="border-b border-neutral-100 last:border-0">
                <th scope="row" className="px-3 py-2 text-left align-top font-semibold text-neutral-900">
                  {row.size}
                </th>
                <td className="px-3 py-2 align-top">
                  <div className="flex items-center gap-1 pt-2">
                    <span className="font-mono text-xs break-all text-neutral-600">{row.sku}</span>
                    <CopySkuButton sku={row.sku} />
                  </div>
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="relative w-36">
                    <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-neutral-600">
                      Rp
                    </span>
                    <Input
                      aria-label={`Harga khusus untuk ukuran ${row.size}`}
                      inputMode="numeric"
                      value={effectivePrice(row)}
                      onChange={(event) => changePrice(row, event.target.value)}
                      placeholder={formatNumber(basePrice)}
                      disabled={saving}
                      error={fieldErrors[`${row.sku}:priceOverrideAmount`]}
                      className="h-10 min-h-0 w-full pl-8 text-right"
                    />
                  </div>
                </td>
                <td className="px-3 py-2 align-top">
                  <Input
                    aria-label={`Stok minimum untuk ukuran ${row.size}`}
                    inputMode="numeric"
                    value={effectiveMinStock(row)}
                    onChange={(event) => changeMinStock(row, event.target.value)}
                    disabled={saving}
                    error={fieldErrors[`${row.sku}:minStockQty`]}
                    className="h-10 min-h-0 w-20 text-right"
                  />
                </td>
                <td className="px-3 py-2 align-top pt-3">
                  <VariantActiveSwitch
                    size={row.size}
                    isActive={row.isActive}
                    pending={togglePending[row.sku] ?? false}
                    error={toggleErrors[row.sku]}
                    onToggle={() => toggleActive(row)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one compact card per size — no horizontal scrolling. */}
      <ul className="flex flex-col gap-2 sm:hidden">
        {rows.map((row) => (
          <li key={row.sku} className="rounded-md border border-neutral-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="font-semibold text-neutral-900">{row.size}</span>
                <span className="text-neutral-400" aria-hidden="true">
                  ·
                </span>
                <span className="truncate font-mono text-xs text-neutral-600">{row.sku}</span>
                <CopySkuButton sku={row.sku} />
              </div>
              <VariantActiveSwitch
                size={row.size}
                isActive={row.isActive}
                pending={togglePending[row.sku] ?? false}
                error={toggleErrors[row.sku]}
                onToggle={() => toggleActive(row)}
              />
            </div>
            <div className="mt-2 flex gap-2">
              <div className="flex-1">
                <Label className="text-xs font-normal text-neutral-600">Harga khusus</Label>
                <div className="relative mt-1">
                  <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-neutral-600">
                    Rp
                  </span>
                  <Input
                    aria-label={`Harga khusus untuk ukuran ${row.size}`}
                    inputMode="numeric"
                    value={effectivePrice(row)}
                    onChange={(event) => changePrice(row, event.target.value)}
                    placeholder={formatNumber(basePrice)}
                    disabled={saving}
                    error={fieldErrors[`${row.sku}:priceOverrideAmount`]}
                    className="h-10 min-h-0 w-full pl-8 text-right"
                  />
                </div>
              </div>
              <div className="w-24">
                <Label className="text-xs font-normal text-neutral-600">Stok min.</Label>
                <Input
                  aria-label={`Stok minimum untuk ukuran ${row.size}`}
                  inputMode="numeric"
                  value={effectiveMinStock(row)}
                  onChange={(event) => changeMinStock(row, event.target.value)}
                  disabled={saving}
                  error={fieldErrors[`${row.sku}:minStockQty`]}
                  className="mt-1 h-10 min-h-0 w-full text-right"
                />
              </div>
            </div>
          </li>
        ))}
      </ul>

      {formError && (
        <p role="alert" className="mt-3 text-sm text-danger-700">
          {formError}
        </p>
      )}

      {isDirty && (
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={discard} disabled={saving}>
            Batal
          </Button>
          <Button type="button" onClick={save} loading={saving}>
            Simpan perubahan
          </Button>
        </div>
      )}
    </div>
  );
}

function AddVariantForm({
  productId,
  fabricId,
  sizeMode,
  availableColors,
}: {
  productId: string;
  fabricId: string;
  sizeMode: SizeMode;
  availableColors: AvailableColor[];
}) {
  const router = useRouter();
  const [selectedColorIds, setSelectedColorIds] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleColor(id: string) {
    setSelectedColorIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  function toggleSize(size: string) {
    setSizes((prev) => (prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size]));
  }

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const sizesToUse = (sizeMode === "all_size" ? ["ALLSIZE"] : sizes) as Size[];
      // A single atomic call creates every selected color x size in one transaction (all or
      // nothing) — see productQueries.addVariants' doc comment. On failure nothing was created,
      // so the selection is simply left as-is for the user to retry after addressing the error.
      const result = await addVariantsAction({
        productId,
        selections: selectedColorIds.map((fabricColorId) => ({ fabricColorId, sizes: sizesToUse })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.inactiveColorNames.length > 0) {
        setNotice(
          `Varian warna ${result.data.inactiveColorNames.join(", ")} belum aktif. Unggah foto warna ini lalu aktifkan.`,
        );
      }
      setSelectedColorIds([]);
      setSizes([]);
      router.refresh();
    });
  }

  if (availableColors.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-center">
        <p className="text-base text-neutral-600">Belum ada warna untuk bahan ini.</p>
        <Link href={`/bahan/${fabricId}`} className="text-sm font-medium text-brand hover:underline">
          Tambah warna di halaman Bahan
        </Link>
      </div>
    );
  }

  const canSubmit = selectedColorIds.length > 0 && (sizeMode === "all_size" || sizes.length > 0);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-300 p-4"
    >
      <p className="text-base font-semibold text-neutral-900">Tambah varian</p>

      <div className="flex flex-col gap-2">
        <Label>Warna</Label>
        <div className="flex flex-wrap gap-3">
          {availableColors.map((color) => (
            <label
              key={color.id}
              className="flex min-h-11 items-center gap-2 rounded-md border border-neutral-300 px-3 text-base text-neutral-900"
            >
              <input
                type="checkbox"
                checked={selectedColorIds.includes(color.id)}
                onChange={() => toggleColor(color.id)}
                disabled={pending}
                className="size-5 rounded border-neutral-500 text-brand"
              />
              <ColorSwatch hex={color.hex} className="size-4" />
              {color.name}
            </label>
          ))}
        </div>
      </div>

      {sizeMode === "sized" ? (
        <div className="flex flex-col gap-2">
          <Label>Ukuran</Label>
          <div className="flex flex-wrap gap-3">
            {SIZED_SIZES.map((size) => (
              <Checkbox key={size} label={size} checked={sizes.includes(size)} onChange={() => toggleSize(size)} disabled={pending} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-neutral-600">Produk ini menggunakan All Size — satu varian per warna.</p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-warning-700">
          {notice}
        </p>
      )}

      <Button type="submit" loading={pending} disabled={!canSubmit}>
        Tambah varian
      </Button>
    </form>
  );
}

export function VariantBuilder({
  productId,
  fabricId,
  sizeMode,
  basePrice,
  variants,
  availableColors,
}: {
  productId: string;
  fabricId: string;
  sizeMode: SizeMode;
  basePrice: number;
  variants: VariantRow[];
  availableColors: AvailableColor[];
}) {
  const active = variants.filter((v) => v.isActive);
  const inactive = variants.filter((v) => !v.isActive);

  const colorsOf = (list: VariantRow[]) => {
    const groups = new Map<string, VariantRow[]>();
    for (const variant of list) {
      const group = groups.get(variant.colorName) ?? [];
      group.push(variant);
      groups.set(variant.colorName, group);
    }
    return [...groups.entries()];
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        {colorsOf(active).map(([colorName, rows]) => (
          <VariantColorGroup
            key={`${colorName}:${rows[0]?.colorHex}`}
            productId={productId}
            colorName={colorName}
            colorHex={rows[0]?.colorHex ?? null}
            rows={rows}
            basePrice={basePrice}
          />
        ))}
        {active.length === 0 && <p className="text-base text-neutral-600">Belum ada varian aktif.</p>}
      </div>

      <AddVariantForm productId={productId} fabricId={fabricId} sizeMode={sizeMode} availableColors={availableColors} />

      {inactive.length > 0 && (
        <details className="rounded-lg border border-neutral-200 p-4">
          <summary className="cursor-pointer text-base font-semibold text-neutral-900">
            Nonaktif ({inactive.length})
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {colorsOf(inactive).map(([colorName, rows]) => (
              <VariantColorGroup
                key={`${colorName}:${rows[0]?.colorHex}`}
                productId={productId}
                colorName={colorName}
                colorHex={rows[0]?.colorHex ?? null}
                rows={rows}
                basePrice={basePrice}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardList, Dialog, EmptyState, Input, Label, TableContainer, TableHead, Td, Th, Tr, useToast } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { sizeLabel } from "@ammari/commerce/size-label";
import type { TikTokSkuMappingView, UnmappedTikTokSku } from "@ammari/commerce/tiktok";
import type { MatchVariantOption } from "@/lib/marketplace-import/variant-search";
import { mapTikTokSkuAction, searchTikTokMatchVariantsAction, unmapTikTokSkuAction } from "../actions";

// Pemetaan SKU TikTok (docs/plans/tiktok-shop-integration.md §3.3, Q12; T4). The server re-checks
// integrations.manage on every action and writes the audit row; this only drives the lists and the
// "Cocokkan ke varian" dialog. A person searches; nothing is matched by name automatically.

interface Target {
  tiktokSkuId: string;
  sellerSku: string | null;
  name: string | null;
}

function when(date: Date): string {
  return `${formatDateTime(date)} WIB`;
}

function tiktokName(sku: { productName?: string | null; skuName?: string | null }): string | null {
  const parts = [sku.productName, sku.skuName].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function MatchDialog({ target, onClose, onPicked }: { target: Target | null; onClose: () => void; onPicked: () => void }) {
  const searchId = useId();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MatchVariantOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();
  // Only the latest search may show its results (a slower, older answer is dropped).
  const searchSeq = useRef(0);

  function search() {
    const q = query.trim();
    if (q.length < 2) {
      setError("Ketik minimal 2 huruf.");
      return;
    }
    setError(null);
    const seq = ++searchSeq.current;
    startSearch(async () => {
      try {
        const found = await searchTikTokMatchVariantsAction(q);
        if (seq === searchSeq.current) setResults(found);
      } catch {
        if (seq === searchSeq.current) setError("Pencarian gagal. Coba lagi.");
      }
    });
  }

  function pick(variantSku: string) {
    if (!target) return;
    setError(null);
    startSave(async () => {
      let result: Awaited<ReturnType<typeof mapTikTokSkuAction>>;
      try {
        result = await mapTikTokSkuAction(target.tiktokSkuId, variantSku);
      } catch {
        setError("Belum tersimpan. Periksa koneksi lalu coba lagi.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`SKU TikTok dipetakan ke ${variantSku}.`);
      onPicked();
    });
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Cocokkan ke varian"
      description={target ? `SKU TikTok ${target.tiktokSkuId}${target.sellerSku ? `, SKU penjual: ${target.sellerSku}` : ""}.` : undefined}
      cancelLabel="Tutup"
      loading={saving}
    >
      <div className="flex flex-col gap-3">
        {target?.name && <p className="text-sm text-neutral-600">Nama di TikTok: {target.name}</p>}
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor={searchId}>Cari varian admin</Label>
            <Input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Produk, kode, warna atau SKU" autoComplete="off" />
          </div>
          <Button type="submit" variant="secondary" loading={searching}>
            Cari
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        )}
        {results !== null && results.length === 0 && <p className="text-sm text-neutral-600">Tidak ada varian yang cocok.</p>}
        {results !== null && results.length > 0 && (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label="Hasil pencarian varian">
            {results.map((option) => (
              <li key={option.sku} className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 p-2">
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-neutral-900">
                    {option.productName}{" "}
                    <span className="font-normal text-neutral-600">
                      {option.colorName} · {sizeLabel(option.size)}
                    </span>
                  </span>
                  <span className="font-mono text-sm break-all text-neutral-700">{option.sku}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!option.isActive && <Badge>Nonaktif</Badge>}
                  <Button type="button" onClick={() => pick(option.sku)} disabled={saving} aria-label={`Pilih ${option.sku}`}>
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

export function TikTokSkuMappingLists({ unmapped, mappings }: { unmapped: UnmappedTikTokSku[]; mappings: TikTokSkuMappingView[] }) {
  const router = useRouter();
  const toast = useToast();
  const [target, setTarget] = useState<Target | null>(null);
  const [removing, setRemoving] = useState<TikTokSkuMappingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removePending, startRemove] = useTransition();

  function remove() {
    const mapping = removing;
    if (!mapping) return;
    setError(null);
    startRemove(async () => {
      let result: Awaited<ReturnType<typeof unmapTikTokSkuAction>>;
      try {
        result = await unmapTikTokSkuAction(mapping.tiktokSkuId);
      } catch {
        setRemoving(null);
        setError("Belum terhapus. Periksa koneksi lalu coba lagi.");
        return;
      }
      setRemoving(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Pemetaan dihapus.");
      router.refresh();
    });
  }

  const open = (sku: { tiktokSkuId: string; sellerSku: string | null; productName?: string | null; skuName?: string | null }) =>
    setTarget({ tiktokSkuId: sku.tiktokSkuId, sellerSku: sku.sellerSku, name: tiktokName(sku) });

  return (
    <div className="flex flex-col gap-8">
      {error && (
        <p role="alert" className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
          {error}
        </p>
      )}

      <section aria-labelledby="tiktok-unmapped-heading" className="flex flex-col gap-3">
        <h2 id="tiktok-unmapped-heading" className="text-lg font-semibold text-neutral-900">
          Belum dipetakan ({formatNumber(unmapped.length)})
        </h2>
        <p className="text-sm text-neutral-600">
          SKU dari pesanan TikTok yang belum punya varian Ammari. Pesanan dengan SKU ini ditahan sampai dipetakan. SKU penjual yang sama persis dengan SKU Ammari dipetakan otomatis.
        </p>
        {unmapped.length === 0 ? (
          <EmptyState title="Semua SKU TikTok sudah dipetakan" description="SKU baru muncul di sini saat ada pesanan dengan SKU yang belum dikenal." />
        ) : (
          <>
            <CardList>
              {unmapped.map((sku) => (
                <li key={sku.tiktokSkuId}>
                  <Card className="flex flex-col gap-1">
                    <span className="text-base font-semibold break-words text-neutral-900">{tiktokName(sku) ?? "Tanpa nama"}</span>
                    <span className="text-sm text-neutral-600">SKU penjual: {sku.sellerSku ?? "kosong"}</span>
                    <span className="font-mono text-sm break-all text-neutral-600">ID SKU TikTok: {sku.tiktokSkuId}</span>
                    <span className="text-sm text-neutral-600">
                      {formatNumber(sku.orderCount)} pesanan, terakhir {when(sku.lastSeenAt)}
                    </span>
                    <Button className="mt-2 w-full" onClick={() => open(sku)} aria-label={`Cocokkan SKU TikTok ${sku.tiktokSkuId} ke varian`}>
                      Cocokkan ke varian
                    </Button>
                  </Card>
                </li>
              ))}
            </CardList>
            <TableContainer>
              <TableHead>
                <Th>Nama di TikTok</Th>
                <Th>SKU penjual</Th>
                <Th>ID SKU TikTok</Th>
                <Th>Pesanan</Th>
                <Th>Terakhir terlihat</Th>
                <Th>
                  <span className="sr-only">Aksi</span>
                </Th>
              </TableHead>
              <tbody>
                {unmapped.map((sku) => (
                  <Tr key={sku.tiktokSkuId}>
                    <Td className="font-medium text-neutral-900">{tiktokName(sku) ?? "Tanpa nama"}</Td>
                    <Td className="font-mono text-sm text-neutral-700">{sku.sellerSku ?? "kosong"}</Td>
                    <Td className="font-mono text-sm text-neutral-700">{sku.tiktokSkuId}</Td>
                    <Td className="text-neutral-700">{formatNumber(sku.orderCount)}</Td>
                    <Td className="text-neutral-700">{when(sku.lastSeenAt)}</Td>
                    <Td className="text-right">
                      <Button variant="secondary" onClick={() => open(sku)} aria-label={`Cocokkan SKU TikTok ${sku.tiktokSkuId} ke varian`}>
                        Cocokkan ke varian
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableContainer>
          </>
        )}
      </section>

      <section aria-labelledby="tiktok-mapped-heading" className="flex flex-col gap-3">
        <h2 id="tiktok-mapped-heading" className="text-lg font-semibold text-neutral-900">
          Sudah dipetakan ({formatNumber(mappings.length)})
        </h2>
        <p className="text-sm text-neutral-600">Satu SKU TikTok ke satu varian Ammari. Mengubah pemetaan tidak mengubah pesanan yang sudah masuk ke admin.</p>
        {mappings.length === 0 ? (
          <EmptyState title="Belum ada pemetaan" description="Pemetaan muncul di sini setelah dicocokkan, atau otomatis saat SKU penjual sama dengan SKU Ammari." />
        ) : (
          <>
            <CardList>
              {mappings.map((mapping) => (
                <li key={mapping.tiktokSkuId}>
                  <Card className="flex flex-col gap-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-mono text-base font-semibold break-all text-neutral-900">{mapping.variantSku}</span>
                      <Badge variant={mapping.source === "manual" ? "neutral" : "success"}>{mapping.source === "manual" ? "Manual" : "Otomatis"}</Badge>
                    </div>
                    <span className="text-sm text-neutral-700">
                      {mapping.productName} · {mapping.colorName} · {sizeLabel(mapping.size)}
                    </span>
                    <span className="text-sm text-neutral-600">SKU penjual: {mapping.sellerSku ?? "kosong"}</span>
                    <span className="font-mono text-sm break-all text-neutral-600">ID SKU TikTok: {mapping.tiktokSkuId}</span>
                    <span className="text-sm text-neutral-600">
                      {when(mapping.mappedAt)}
                      {mapping.mappedByName ? ` oleh ${mapping.mappedByName}` : ""}
                    </span>
                    <div className="mt-2 flex flex-col gap-2">
                      <Button variant="secondary" className="w-full" onClick={() => open(mapping)} aria-label={`Ubah pemetaan ${mapping.tiktokSkuId}`}>
                        Ubah
                      </Button>
                      <Button variant="secondary" className="w-full" onClick={() => setRemoving(mapping)} aria-label={`Hapus pemetaan ${mapping.tiktokSkuId}`}>
                        Hapus pemetaan
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </CardList>
            <TableContainer>
              <TableHead>
                <Th>Varian Ammari</Th>
                <Th>SKU penjual</Th>
                <Th>ID SKU TikTok</Th>
                <Th>Cara</Th>
                <Th>Dipetakan</Th>
                <Th>
                  <span className="sr-only">Aksi</span>
                </Th>
              </TableHead>
              <tbody>
                {mappings.map((mapping) => (
                  <Tr key={mapping.tiktokSkuId}>
                    <Td>
                      <div className="flex flex-col">
                        <span className="font-mono text-sm font-medium text-neutral-900">{mapping.variantSku}</span>
                        <span className="text-sm text-neutral-600">
                          {mapping.productName} · {mapping.colorName} · {sizeLabel(mapping.size)}
                        </span>
                      </div>
                    </Td>
                    <Td className="font-mono text-sm text-neutral-700">{mapping.sellerSku ?? "kosong"}</Td>
                    <Td className="font-mono text-sm text-neutral-700">{mapping.tiktokSkuId}</Td>
                    <Td>
                      <Badge variant={mapping.source === "manual" ? "neutral" : "success"}>{mapping.source === "manual" ? "Manual" : "Otomatis"}</Badge>
                    </Td>
                    <Td className="text-sm text-neutral-700">
                      {when(mapping.mappedAt)}
                      {mapping.mappedByName ? ` oleh ${mapping.mappedByName}` : ""}
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={() => open(mapping)} aria-label={`Ubah pemetaan ${mapping.tiktokSkuId}`}>
                          Ubah
                        </Button>
                        <Button variant="secondary" onClick={() => setRemoving(mapping)} aria-label={`Hapus pemetaan ${mapping.tiktokSkuId}`}>
                          Hapus
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableContainer>
          </>
        )}
      </section>

      <MatchDialog
        key={target?.tiktokSkuId ?? "none"}
        target={target}
        onClose={() => setTarget(null)}
        onPicked={() => {
          setTarget(null);
          router.refresh();
        }}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(isOpen) => !isOpen && setRemoving(null)}
        title="Hapus pemetaan?"
        description={removing ? `SKU TikTok ${removing.tiktokSkuId} tidak lagi dipetakan ke ${removing.variantSku}. Pesanan baru dengan SKU ini akan ditahan sampai dipetakan lagi.` : undefined}
        confirmLabel="Hapus pemetaan"
        confirmVariant="danger"
        onConfirm={remove}
        loading={removePending}
      />
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Image as ImageIcon, Plus } from "lucide-react";
import { Badge, Button, ColorSwatch, Dialog } from "@ammari/ui";
import { reorderProductImagesAction } from "../actions";
import { PhotoTile } from "./photo-tile";
import { PendingPhotoTile } from "./pending-photo-tile";
import { usePhotoStaging } from "./use-photo-staging";
import type { PendingPhoto, PhotoColorGroup, PhotoImage } from "./photo-types";

export type { PhotoColorGroup, PhotoImage } from "./photo-types";

function AddPhotoTile({
  fabricColorId,
  disabled,
  onSelectFiles,
}: {
  fabricColorId: string | null;
  disabled: boolean;
  onSelectFiles: (fabricColorId: string | null, files: FileList | null) => void;
}) {
  return (
    <>
      <input
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        id={`photo-picker-${fabricColorId ?? "general"}`}
        onChange={(event) => {
          onSelectFiles(fabricColorId, event.target.files);
          event.target.value = "";
        }}
        disabled={disabled}
      />
      <label
        htmlFor={`photo-picker-${fabricColorId ?? "general"}`}
        className="flex aspect-4/5 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-neutral-300 text-neutral-500 transition-colors duration-150 hover:border-neutral-400 hover:text-neutral-700 has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand aria-disabled:pointer-events-none aria-disabled:opacity-60"
        aria-disabled={disabled}
      >
        <Plus className="size-6" aria-hidden="true" />
        <span className="text-sm font-medium">Tambah foto</span>
      </label>
    </>
  );
}

function PhotoGroup({
  title,
  hex,
  isGeneral,
  warn,
  productId,
  fabricColorId,
  images,
  thumbnailImageId,
  pendingPhotos,
  staging,
  onSelectFiles,
  onRemoveFile,
}: {
  title: string;
  hex?: string | null;
  isGeneral?: boolean;
  warn?: boolean;
  productId: string;
  fabricColorId: string | null;
  images: PhotoImage[];
  thumbnailImageId: string | null;
  pendingPhotos: PendingPhoto[];
  staging: boolean;
  onSelectFiles: (fabricColorId: string | null, files: FileList | null) => void;
  onRemoveFile: (localId: string) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [reordering, startReorderTransition] = useTransition();
  const sorted = [...images].sort((a, b) => a.sortOrder - b.sortOrder);

  // useTransition, not a plain useState+try/finally flag — router.refresh() returns void (it
  // only fires the request), so a manual flag flips `reordering` back to false the instant the
  // refresh is REQUESTED, not once the refreshed order has actually landed and re-rendered.
  // Wrapping it in startTransition is what keeps `isPending` (and so `reordering`, which
  // disables every tile's "Geser" menu items) true until that refresh's RSC payload actually
  // commits — closing the exact race this guard exists for: two rapid moves both reading the
  // same stale `sorted` closure. PhotoTile's own actions (thumbnail/alt-text/delete) use the
  // same pattern for the same reason.
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sorted.length) return;
    const reordered = [...sorted];
    const temp = reordered[index]!;
    reordered[index] = reordered[target]!;
    reordered[target] = temp;

    setError(null);
    startReorderTransition(async () => {
      try {
        const result = await reorderProductImagesAction({
          productId,
          fabricColorId,
          orderedImageIds: reordered.map((image) => image.id),
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch {
        setError("Gagal mengubah urutan foto. Coba lagi.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`photo-group-${fabricColorId ?? "general"}`}>
      <div className="flex items-center gap-2">
        {isGeneral ? (
          <span className="flex size-5 shrink-0 items-center justify-center text-neutral-400" aria-hidden="true">
            <ImageIcon className="size-4" />
          </span>
        ) : (
          <ColorSwatch hex={hex ?? null} />
        )}
        <h3 className="text-base font-semibold text-neutral-900">{title}</h3>
        <span className="text-sm text-neutral-500">{sorted.length} foto</span>
        {warn && <Badge variant="warning">Belum ada foto</Badge>}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {sorted.map((image, index) => (
          <PhotoTile
            key={image.id}
            productId={productId}
            image={image}
            index={index}
            total={sorted.length}
            isMain={index === 0}
            isThumbnail={image.id === thumbnailImageId}
            reordering={reordering}
            onMoveLeft={() => move(index, -1)}
            onMoveRight={() => move(index, 1)}
          />
        ))}
        {pendingPhotos.map((photo) => (
          <PendingPhotoTile key={photo.localId} photo={photo} onRemove={() => onRemoveFile(photo.localId)} disabled={staging} />
        ))}
        <AddPhotoTile fabricColorId={fabricColorId} disabled={staging} onSelectFiles={onSelectFiles} />
      </div>
    </div>
  );
}

export function ProductPhotosSection({
  productId,
  thumbnailImageId,
  colorGroups,
  images,
}: {
  productId: string;
  thumbnailImageId: string | null;
  colorGroups: PhotoColorGroup[];
  images: PhotoImage[];
}) {
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const { pending, saving, addFiles, removeFile, discardAll, saveAll } = usePhotoStaging({
    productId,
    onSaved: () => {},
  });
  const generalImages = images.filter((image) => image.fabricColorId === null);

  function confirmDiscard() {
    discardAll();
    setCancelDialogOpen(false);
  }

  return (
    <div className="flex flex-col gap-8 pb-36 sm:pb-0">
      <h2 className="text-lg font-semibold text-neutral-900">Foto</h2>
      <PhotoGroup
        title="Foto umum (semua warna)"
        isGeneral
        productId={productId}
        fabricColorId={null}
        images={generalImages}
        thumbnailImageId={thumbnailImageId}
        pendingPhotos={pending.filter((photo) => photo.fabricColorId === null)}
        staging={saving}
        onSelectFiles={addFiles}
        onRemoveFile={removeFile}
      />
      {colorGroups.map((group) => (
        <PhotoGroup
          key={group.fabricColorId}
          title={group.name}
          hex={group.hex}
          warn={group.hasActiveVariant && group.imageCount === 0}
          productId={productId}
          fabricColorId={group.fabricColorId}
          images={images.filter((image) => image.fabricColorId === group.fabricColorId)}
          thumbnailImageId={thumbnailImageId}
          pendingPhotos={pending.filter((photo) => photo.fabricColorId === group.fabricColorId)}
          staging={saving}
          onSelectFiles={addFiles}
          onRemoveFile={removeFile}
        />
      ))}

      {pending.length > 0 && (
        <div
          data-testid="unsaved-photos-bar"
          // bottom-[3.5rem+safe-area] on phones, not bottom-0 — sits directly above
          // BottomNav (fixed, same inset-x-0, 3.5rem tall + the same safe-area inset; see
          // admin-shell.tsx's <main> padding, which reserves exactly this much) instead of
          // underneath it, where its buttons would be unreachable (BottomNav's higher z-30
          // intercepts every pointer event there).
          className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border-t border-neutral-200 bg-white px-4 py-3 shadow-md sm:static sm:inset-auto sm:z-auto sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:shadow-none"
        >
          {/* Compact, middot-joined line on phones (sticky to the viewport bottom); a plainer
              button row on larger screens where a fixed bar isn't needed. */}
          <div className="flex items-center justify-center gap-1.5 text-sm text-neutral-700 sm:hidden">
            <span data-testid="unsaved-photos-count">{pending.length} foto belum disimpan</span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setCancelDialogOpen(true)}
              disabled={saving}
              data-testid="discard-photos-button"
              className="flex min-h-11 min-w-11 items-center justify-center px-2 font-medium text-neutral-900 disabled:opacity-60"
            >
              Batal
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => void saveAll()}
              disabled={saving}
              aria-busy={saving || undefined}
              data-testid="save-photos-button"
              className="flex min-h-11 min-w-11 items-center justify-center px-2 font-medium text-brand disabled:opacity-60"
            >
              {saving ? "Menyimpan…" : "Simpan"}
            </button>
          </div>

          <div className="hidden items-center justify-end gap-3 sm:flex">
            <span className="text-sm text-neutral-700">{pending.length} foto belum disimpan</span>
            <Button type="button" variant="secondary" onClick={() => setCancelDialogOpen(true)} disabled={saving}>
              Batal
            </Button>
            <Button type="button" onClick={() => void saveAll()} loading={saving}>
              Simpan foto
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        title="Batalkan foto yang belum disimpan?"
        description={`${pending.length} foto yang baru dipilih akan dihapus dari daftar unggah. Foto yang sudah tersimpan tidak terpengaruh.`}
        confirmLabel="Batalkan"
        confirmVariant="danger"
        onConfirm={confirmDiscard}
      />
    </div>
  );
}

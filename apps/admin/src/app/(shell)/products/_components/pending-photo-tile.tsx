"use client";

import { Loader2, X } from "lucide-react";
import { Badge } from "@ammari/ui";
import type { PendingPhoto } from "./photo-types";

export function PendingPhotoTile({
  photo,
  onRemove,
  disabled,
}: {
  photo: PendingPhoto;
  onRemove: () => void;
  /** True while a section-wide "Simpan foto" is in flight — removing an item mid-save can't
   * actually cancel its upload once saveAll has started it (see use-photo-staging.ts), so the
   * button is disabled for every pending tile while saving, not just the one actively
   * uploading. */
  disabled: boolean;
}) {
  return (
    <div className="group relative aspect-4/5" data-testid="pending-photo-tile">
      <div className="absolute inset-0 overflow-hidden rounded-lg border border-neutral-200 outline-1 -outline-offset-1 outline-black/5">
        {/* A local blob preview, never uploaded yet — plain <img>, not ProductImage, since
            there's no remote URL that could 404 and need a fallback. */}
        {photo.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.previewUrl} alt={photo.name} className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center bg-neutral-50 p-2 text-center text-xs text-neutral-500">
            {photo.name}
          </div>
        )}
        {photo.state === "uploading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <Loader2 className="size-6 animate-spin text-neutral-600" aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute left-1.5 top-1.5">
        <Badge variant="warning">Belum disimpan</Badge>
      </div>

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled || photo.state === "uploading"}
        aria-label={`Hapus ${photo.name} dari daftar unggah`}
        className="absolute right-1.5 top-1.5 flex size-8 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-sm transition-opacity duration-150 hover:text-danger-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-60"
      >
        <X className="size-4" aria-hidden="true" />
      </button>

      {photo.state === "error" && (
        <p role="alert" className="absolute inset-x-1.5 bottom-1.5 rounded-md bg-danger-50 px-2 py-1 text-xs text-danger-700">
          {photo.error}
        </p>
      )}
    </div>
  );
}

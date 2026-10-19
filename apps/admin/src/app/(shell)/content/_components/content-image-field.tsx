"use client";

import { useId, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button, Input, Label } from "@ammari/ui";
import { downscaleImageForUpload } from "@/lib/products/client-image-resize";
import { uploadContentImageAction } from "../actions";

// ---------- Content image upload field (docs/plans/storefront-cms.md, session 5) ----------
//
// Shared by HeroForm and FeatureBlockForm — replaces the "Unggah gambar akan tersedia di sesi
// berikutnya" placeholder with a real uploader: preview, replace, remove, required alt text.
//
// Unlike the product-photo section's `usePhotoStaging` (apps/admin/src/app/(shell)/products/
// _components/use-photo-staging.ts), a picked file is uploaded to storage IMMEDIATELY, not held
// client-side until a later "Simpan foto" — there's no DB row for a content image to defer
// (it's a plain JSONB snapshot, see homepage-schemas.ts's contentImageSchema), and the plan's own
// "Image uploads" section describes replacing an image as "uploading a new one ... and only then
// overwriting the old storageKey in the draft JSON" — i.e. upload-then-reference, not
// stage-then-upload-on-save. The cost (an upload the admin never saves into a draft becomes an
// orphaned object) is the SAME accepted tradeoff apps/admin/src/lib/products/image-queries.ts's
// own "an orphaned object in the bucket is a harmless no-op" comment already makes.

export interface ContentImageCropValue {
  storageKey: string;
  width: number;
  height: number;
  previewUrl: string;
}

export interface ContentImageFieldValue extends ContentImageCropValue {
  altText: string;
  mobile: ContentImageCropValue | null;
}

// Mirrors use-photo-staging.ts's own client-side check — an immediate, specific Indonesian
// message for the common case, before ever reaching the network. The server (processUploadedImage
// via content-image-queries.ts) re-validates independently by content-sniffing the actual bytes,
// so this is a UX nicety only, never the real guard.
const ACCEPTED_CLIENT_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_CLIENT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

function clientValidationError(file: File): string | null {
  if (!ACCEPTED_CLIENT_TYPES.includes(file.type)) {
    // Covers the iOS/iPadOS edge case too: accept="image/jpeg,image/png,image/webp" on the
    // <input> below makes Safari hand over a transcoded JPEG for a HEIC photo picked from the
    // library, but a HEIC opened directly via the Files app can still arrive as image/heic/heif
    // — this is the clear Indonesian rejection for exactly that case, not a server error.
    return "Format file harus JPEG, PNG, atau WebP. Foto HEIC dari iPhone/iPad akan otomatis diubah ke JPEG saat dipilih dari Galeri. Jika masih gagal, coba ekspor foto sebagai JPEG terlebih dahulu.";
  }
  if (file.size > MAX_CLIENT_FILE_SIZE_BYTES) {
    return "Ukuran file maksimal 10 MB.";
  }
  return null;
}

function CropPreview({
  crop,
  altText,
  uploading,
  onReplace,
  onRemove,
  removeLabel,
  disabled,
}: {
  crop: ContentImageCropValue;
  altText: string;
  uploading: boolean;
  onReplace: () => void;
  onRemove: () => void;
  removeLabel: string;
  disabled: boolean;
}) {
  return (
    <div className="group relative aspect-video w-full max-w-md overflow-hidden rounded-lg border border-neutral-200 outline-1 -outline-offset-1 outline-black/5">
      {/* eslint-disable-next-line @next/next/no-img-element -- storage-hosted (or e2e data:) URL, not a Next-optimizable static asset */}
      <img src={crop.previewUrl} alt={altText} className="size-full object-cover" />
      {uploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70">
          <Loader2 className="size-6 animate-spin text-neutral-600" aria-hidden="true" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/50 px-2 py-1.5">
        <button
          type="button"
          onClick={onReplace}
          disabled={disabled}
          className="min-h-11 rounded px-2 text-sm font-medium text-white hover:bg-white/10 disabled:pointer-events-none disabled:opacity-60"
        >
          Ganti gambar
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={removeLabel}
          className="flex size-9 items-center justify-center rounded-full text-white hover:bg-white/10 disabled:pointer-events-none disabled:opacity-60"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function ContentImageField({
  sectionKey,
  label,
  value,
  onChange,
  allowMobileCrop = false,
  disabled = false,
}: {
  sectionKey: "hero" | "feature_block";
  label: string;
  value: ContentImageFieldValue | null;
  onChange: (value: ContentImageFieldValue | null) => void;
  allowMobileCrop?: boolean;
  disabled?: boolean;
}) {
  const idPrefix = useId();
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [desktopUploading, setDesktopUploading] = useState(false);
  const [mobileUploading, setMobileUploading] = useState(false);
  // "Memproses foto..." while the client-side resize (client-image-resize.ts) runs, before the
  // upload itself starts — distinct from desktop/mobileUploading's spinner, which already covers
  // both phases. In dev, the text grows a size/timing suffix once the resize result is known,
  // mirroring that module's own `[image-resize]` console log so the two are easy to correlate.
  const [desktopStatus, setDesktopStatus] = useState<string | null>(null);
  const [mobileStatus, setMobileStatus] = useState<string | null>(null);
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(variant: "desktop" | "mobile", file: File) {
    const setError = variant === "desktop" ? setDesktopError : setMobileError;
    const setUploading = variant === "desktop" ? setDesktopUploading : setMobileUploading;
    const setStatus = variant === "desktop" ? setDesktopStatus : setMobileStatus;

    const clientError = clientValidationError(file);
    if (clientError) {
      setError(clientError);
      return;
    }
    setError(null);
    setUploading(true);
    setStatus("Memproses foto...");

    try {
      const resized = await downscaleImageForUpload(file);
      if (process.env.NODE_ENV !== "production") {
        const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
        setStatus(`Memproses foto... (${mb(resized.inputBytes)}MB → ${mb(resized.outputBytes)}MB, ${resized.timingMs}ms)`);
      } else {
        setStatus(null);
      }

      const formData = new FormData();
      formData.set("sectionKey", sectionKey);
      formData.set("variant", variant);
      formData.set("file", resized.file, file.name);

      const result = await uploadContentImageAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      if (variant === "desktop") {
        onChange({ ...result.data, altText: value?.altText ?? "", mobile: value?.mobile ?? null });
      } else {
        if (!value) return; // mobile crop requires an existing desktop image — UI never offers it otherwise
        onChange({ ...value, mobile: result.data });
      }
    } catch {
      setError("Gagal mengunggah gambar. Coba lagi.");
    } finally {
      setUploading(false);
      setStatus(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-300 p-3">
      <span className="text-sm font-medium text-neutral-700">{label}</span>

      <input
        ref={desktopInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        id={`${idPrefix}-desktop-input`}
        data-testid="content-image-input-desktop"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handleFile("desktop", file);
        }}
        disabled={disabled || desktopUploading}
      />

      {value ? (
        <>
          <CropPreview
            crop={value}
            altText={value.altText}
            uploading={desktopUploading}
            onReplace={() => desktopInputRef.current?.click()}
            onRemove={() => onChange(null)}
            removeLabel={`Hapus ${label.toLowerCase()}`}
            disabled={disabled || desktopUploading}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-alt-text`} required>
              Teks alternatif
            </Label>
            <Input
              id={`${idPrefix}-alt-text`}
              value={value.altText}
              onChange={(event) => onChange({ ...value, altText: event.target.value })}
              placeholder="Jelaskan gambar ini untuk pembaca layar, mis. 'Model memakai gamis hijau sage'"
              maxLength={200}
              disabled={disabled}
              required
            />
          </div>
        </>
      ) : (
        <Button type="button" variant="secondary" onClick={() => desktopInputRef.current?.click()} disabled={disabled || desktopUploading} loading={desktopUploading}>
          Unggah gambar
        </Button>
      )}

      {desktopStatus && (
        <p className="text-sm text-neutral-600" data-testid="content-image-status-desktop">
          {desktopStatus}
        </p>
      )}

      {desktopError && (
        <p role="alert" className="text-sm text-danger-700">
          {desktopError}
        </p>
      )}

      {allowMobileCrop && value && (
        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
          <span className="text-sm font-medium text-neutral-700">Crop khusus mobile (opsional)</span>
          <p className="text-sm text-neutral-600">
            Dipakai sebagai gambar hero di layar sempit (ponsel) jika diisi. Jika tidak, gambar utama di atas dipakai untuk semua ukuran layar.
          </p>

          <input
            ref={mobileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            id={`${idPrefix}-mobile-input`}
            data-testid="content-image-input-mobile"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleFile("mobile", file);
            }}
            disabled={disabled || mobileUploading}
          />

          {value.mobile ? (
            <CropPreview
              crop={value.mobile}
              altText={value.altText}
              uploading={mobileUploading}
              onReplace={() => mobileInputRef.current?.click()}
              onRemove={() => onChange({ ...value, mobile: null })}
              removeLabel="Hapus crop mobile"
              disabled={disabled || mobileUploading}
            />
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => mobileInputRef.current?.click()}
              disabled={disabled || mobileUploading}
              loading={mobileUploading}
            >
              Unggah crop mobile
            </Button>
          )}

          {mobileStatus && (
            <p className="text-sm text-neutral-600" data-testid="content-image-status-mobile">
              {mobileStatus}
            </p>
          )}

          {mobileError && (
            <p role="alert" className="text-sm text-danger-700">
              {mobileError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

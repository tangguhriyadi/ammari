export interface PhotoImage {
  id: string;
  fabricColorId: string | null;
  altText: string | null;
  width: number;
  height: number;
  sortOrder: number;
  urls: Record<400 | 800 | 1600, string>;
}

export interface PhotoColorGroup {
  fabricColorId: string;
  name: string;
  hex: string | null;
  hasActiveVariant: boolean;
  imageCount: number;
}

/** A locally-selected file waiting to be saved (see use-photo-staging.ts) — not yet uploaded, so
 * it has no server id yet. `previewUrl` is an `URL.createObjectURL()` blob URL, revoked once the
 * file is saved or removed. */
export interface PendingPhoto {
  localId: string;
  fabricColorId: string | null;
  file: File;
  name: string;
  previewUrl: string;
  state: "idle" | "uploading" | "error";
  error?: string;
}

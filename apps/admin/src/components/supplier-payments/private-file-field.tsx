"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { Button, Label } from "@ammari/ui";
import { downscaleImageForUpload } from "@/lib/products/client-image-resize";
import { PRIVATE_UPLOAD_ACCEPT, PRIVATE_UPLOAD_MAX_INPUT_BYTES, PROOF_MESSAGES } from "@/lib/supplier-payments/messages";

// The picker for a private upload: a payment proof or a supplier nota
// (docs/plans/purchase-payments.md §6, §9). Phone first: no `capture` attribute, so the phone
// offers the camera AND the gallery, and the accept list makes iOS hand over a HEIC photo as JPEG.
// A photo is downscaled in the browser first (client-image-resize.ts, 2400 px) so it crosses the
// network quickly; the server still re-validates and re-encodes everything from the bytes.

export interface PreparedUpload {
  file: File;
  /** sha256 of exactly the bytes that will be uploaded, for the duplicate-proof warning; null
   * when the browser has no WebCrypto (a plain-http LAN address). */
  sha256: string | null;
  isPdf: boolean;
  /** A local blob: URL for the photo thumbnail (null for a PDF); revoked when replaced. */
  previewUrl: string | null;
}

const ACCEPTED_TYPES = new Set(PRIVATE_UPLOAD_ACCEPT.split(","));

/** Immediate feedback for the common cases. Never the real guard (the server sniffs the bytes). */
function clientError(file: File): string | null {
  if (/^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name)) return PROOF_MESSAGES.heic;
  if (file.size === 0) return PROOF_MESSAGES.unreadable;
  if (file.size > PRIVATE_UPLOAD_MAX_INPUT_BYTES) return PROOF_MESSAGES.tooLarge;
  // An empty type (some Android file managers) is left for the server to decide.
  if (file.type !== "" && !ACCEPTED_TYPES.has(file.type)) return PROOF_MESSAGES.unsupported;
  return null;
}

async function sha256Hex(file: File): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function PrivateFileField({
  id,
  label,
  hint,
  value,
  onChange,
  onProcessingChange,
  error,
  disabled = false,
}: {
  id: string;
  label: string;
  hint: string;
  value: PreparedUpload | null;
  onChange: (value: PreparedUpload | null) => void;
  onProcessingChange?: (processing: boolean) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const previewUrl = value?.previewUrl ?? null;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function handleFile(file: File) {
    const refusal = clientError(file);
    if (refusal) {
      setLocalError(refusal);
      onChange(null);
      return;
    }
    setLocalError(null);
    setProcessing(true);
    onProcessingChange?.(true);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const prepared = isPdf ? file : (await downscaleImageForUpload(file)).file;
      onChange({ file: prepared, sha256: await sha256Hex(prepared), isPdf, previewUrl: isPdf ? null : URL.createObjectURL(prepared) });
    } finally {
      setProcessing(false);
      onProcessingChange?.(false);
    }
  }

  const shownError = localError ?? error ?? null;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = shownError ? `${hintId} ${errorId}` : hintId;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} required>
        {label}
      </Label>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={PRIVATE_UPLOAD_ACCEPT}
        className="sr-only"
        // The visible button below is the keyboard/touch target; the input stays labelled (and
        // reachable for tests and assistive tech) but out of the tab order, so focus lands once.
        tabIndex={-1}
        aria-describedby={describedBy}
        aria-invalid={Boolean(shownError)}
        disabled={disabled || processing}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handleFile(file);
        }}
      />
      {value && (
        <div className="flex items-center gap-3 rounded-md border border-neutral-200 p-2" data-testid="private-file-selected">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview of the picked photo
            <img src={previewUrl} alt="" className="size-14 shrink-0 rounded object-cover outline-1 -outline-offset-1 outline-black/5" />
          ) : (
            <FileText className="size-8 shrink-0 text-neutral-600" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-neutral-900">{value.file.name}</p>
            <p className="text-sm text-neutral-600">{formatSize(value.file.size)}</p>
          </div>
        </div>
      )}
      {/* One trigger for every state (pick, processing, replace), never disabled while processing,
          so keyboard and screen-reader focus stays on it after a file is picked. */}
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        aria-disabled={processing || undefined}
        aria-describedby={describedBy}
        onClick={() => {
          if (!processing) inputRef.current?.click();
        }}
      >
        {processing && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        <span aria-live="polite">{processing ? "Memproses file..." : value ? `Ganti ${label.toLowerCase()}` : "Ambil foto atau pilih file"}</span>
      </Button>
      <p id={hintId} className="text-sm text-neutral-600">
        {hint}
      </p>
      {shownError && (
        <p id={errorId} role="alert" className="text-sm text-danger-700">
          {shownError}
        </p>
      )}
    </div>
  );
}

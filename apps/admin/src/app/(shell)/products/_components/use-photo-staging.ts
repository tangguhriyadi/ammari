import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { downscaleImageForUpload } from "@/lib/products/client-image-resize";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { revalidateProductAction, uploadProductImageAction } from "../actions";
import type { PendingPhoto } from "./photo-types";

let nextLocalId = 0;
function createLocalId(): string {
  nextLocalId += 1;
  return `pending-${nextLocalId}`;
}

const LEAVE_WARNING = "Ada foto yang belum disimpan. Tinggalkan halaman ini?";

/** Staged, section-wide photo uploads (owner feedback: selecting files must not save them
 * immediately). Files are validated and client-side downscaled as soon as they're picked — same
 * as the old immediate-upload flow — but only actually uploaded (and so only subject to the
 * photo/thumbnail business rules, which run server-side in uploadProductImageAction)
 * once the caller invokes `saveAll`. One staging list spans every color group in the photo
 * section, since "Simpan foto" is a single section-wide action, not per-group. */
export function usePhotoStaging({ productId, onSaved }: { productId: string; onSaved: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [saving, setSaving] = useState(false);
  // True while addFiles is downscaling a just-picked batch, before any of it appears as a
  // pending tile — the "Memproses foto..." status (see product-photos-section.tsx). `devResizeInfo`
  // is the dev-only size/timing detail for the last file processed in that batch (see
  // client-image-resize.ts's own `[image-resize]` console log, which this mirrors for the UI).
  const [processing, setProcessing] = useState(false);
  const [devResizeInfo, setDevResizeInfo] = useState<string | null>(null);
  // Set once per `saveAll()` batch (not per file — one revalidation call for the whole batch,
  // not N), null until the first save; docs/plans/storefront-cms.md session 6.
  const [revalidationOk, setRevalidationOk] = useState<boolean | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Mirrors `pending` into a ref so the unmount cleanup below (which must run exactly once, with
  // whatever the list holds at that moment) doesn't need `pending` in its dependency array.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    return () => {
      for (const item of pendingRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  // Warn before losing staged-but-unsaved photos — shared with variant-builder.tsx's unsaved
  // price/stock edits via a module-level registry (see use-unsaved-changes-guard.ts) so the two
  // don't each pop their own window.confirm for a single navigation attempt.
  useUnsavedChangesGuard(pending.length > 0, LEAVE_WARNING);

  async function addFiles(fabricColorId: string | null, fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const staged: PendingPhoto[] = [];
    setProcessing(true);
    setDevResizeInfo(null);

    for (const file of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        staged.push({
          localId: createLocalId(),
          fabricColorId,
          file,
          name: file.name,
          previewUrl: "",
          state: "error",
          error: "Format file harus JPEG, PNG, atau WebP.",
        });
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        staged.push({
          localId: createLocalId(),
          fabricColorId,
          file,
          name: file.name,
          previewUrl: "",
          state: "error",
          error: "Ukuran file maksimal 10 MB.",
        });
        continue;
      }

      const resized = await downscaleImageForUpload(file);
      if (!mountedRef.current) {
        // Bailing out mid-batch (unmounted between files, e.g. navigated away while a later
        // file in the same multi-select was still downscaling) — revoke every object URL
        // already created for EARLIER files in this same loop before returning. They were
        // never committed to `pending` via setPending below, so the unmount-cleanup effect
        // never sees them either; without this they'd leak for the rest of the page session.
        for (const item of staged) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        }
        return;
      }
      if (process.env.NODE_ENV !== "production") {
        const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
        setDevResizeInfo(`${file.name}: ${mb(resized.inputBytes)}MB → ${mb(resized.outputBytes)}MB (${resized.timingMs}ms)`);
      }
      staged.push({
        localId: createLocalId(),
        fabricColorId,
        file: resized.file,
        name: file.name,
        previewUrl: URL.createObjectURL(resized.file),
        state: "idle",
      });
    }

    setPending((prev) => [...prev, ...staged]);
    setProcessing(false);
  }

  function removeFile(localId: string) {
    setPending((prev) => {
      const target = prev.find((item) => item.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.localId !== localId);
    });
  }

  function discardAll() {
    for (const item of pendingRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    setPending([]);
  }

  async function retryRevalidation() {
    const result = await revalidateProductAction(productId);
    if (mountedRef.current) setRevalidationOk(result.ok && result.data.revalidationOk);
  }

  async function saveAll() {
    const toSave = pendingRef.current.filter((item) => item.state !== "uploading");
    if (toSave.length === 0) return;
    setSaving(true);
    let anyUploaded = false;

    for (const item of toSave) {
      if (!mountedRef.current) return;
      // Re-checked against the LIVE list, not the `toSave` snapshot — the remove button is
      // disabled while `saving` is true (see PendingPhotoTile), but this stays correct even if
      // that ever changes: an item removed after this loop started (and so no longer in
      // pendingRef.current) is skipped rather than uploaded anyway.
      if (!pendingRef.current.some((p) => p.localId === item.localId)) continue;
      setPending((prev) => prev.map((p) => (p.localId === item.localId ? { ...p, state: "uploading", error: undefined } : p)));

      const formData = new FormData();
      formData.set("productId", productId);
      if (item.fabricColorId) formData.set("fabricColorId", item.fabricColorId);
      formData.set("file", item.file, item.name);

      try {
        const result = await uploadProductImageAction(formData);
        if (!mountedRef.current) return;
        if (!result.ok) {
          setPending((prev) => prev.map((p) => (p.localId === item.localId ? { ...p, state: "error", error: result.error } : p)));
        } else {
          anyUploaded = true;
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          setPending((prev) => prev.filter((p) => p.localId !== item.localId));
        }
      } catch {
        if (!mountedRef.current) return;
        setPending((prev) =>
          prev.map((p) => (p.localId === item.localId ? { ...p, state: "error", error: "Gagal mengunggah. Coba lagi." } : p)),
        );
      }
    }

    // One revalidation call for the whole batch (not per file) — only when at least one file
    // actually uploaded; a batch that was entirely rejected has nothing to revalidate.
    if (anyUploaded && mountedRef.current) {
      const result = await revalidateProductAction(productId);
      if (mountedRef.current) setRevalidationOk(result.ok && result.data.revalidationOk);
    }

    if (mountedRef.current) {
      setSaving(false);
      onSaved();
      router.refresh();
    }
  }

  return { pending, saving, processing, devResizeInfo, revalidationOk, addFiles, removeFile, discardAll, saveAll, retryRevalidation };
}

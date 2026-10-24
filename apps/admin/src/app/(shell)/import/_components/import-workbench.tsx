"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Label } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import type { ActionResult } from "@/lib/action-result";
import type { ImportPreview as ImportPreviewData } from "@/lib/marketplace-import/preview-view";
import type { UnknownSkuGroup } from "@/lib/marketplace-import/plan";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { STOREFRONT_STALE_MESSAGE } from "@/lib/storefront-stale";
import { commitImportAction, previewImportAction } from "../actions";
import { ImportPreview } from "./import-preview";
import { SkuMatchDialog } from "./sku-match-dialog";

// Upload, Periksa file, Cocokkan ke varian, Simpan (docs/plans/marketplace-import.md §1, §11). The
// browser keeps the File and sends it again with every step: nothing is stored on the server between
// them. The server re-checks everything on Simpan (permission, lock, blockers, digest).

type Channel = "shopee" | "tiktok";

const CHANNELS: { id: Channel; label: string }[] = [
  { id: "shopee", label: "Shopee" },
  { id: "tiktok", label: "TikTok Shop" },
];

const UNEXPECTED_ERROR = "Terjadi kesalahan. Coba lagi.";
const UNSAVED_MESSAGE = "Pratinjau impor belum disimpan. Tinggalkan halaman ini?";

type Notice = { tone: "success" | "info"; text: string };

async function call<T>(action: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await action();
  } catch (error) {
    console.error("[import] action failed to reach the server", error);
    return { ok: false, error: UNEXPECTED_ERROR };
  }
}

function fileSizeText(bytes: number): string {
  return bytes < 1024 * 1024 ? `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB` : `${(bytes / (1024 * 1024)).toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`;
}

export function ImportWorkbench() {
  const router = useRouter();
  const fileInputId = useId();
  const channelName = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [channel, setChannel] = useState<Channel>("shopee");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [matching, setMatching] = useState<UnknownSkuGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [pending, startTransition] = useTransition();

  useUnsavedChangesGuard(preview !== null && preview.saveCount > 0, UNSAVED_MESSAGE);

  function formFor(nextOverrides: Record<string, string>, digest?: string): FormData | null {
    if (!file) return null;
    const formData = new FormData();
    formData.set("channel", channel);
    formData.set("file", file);
    formData.set("skuOverrides", JSON.stringify(nextOverrides));
    if (digest) formData.set("digest", digest);
    return formData;
  }

  function resetPreview() {
    setPreview(null);
    setOverrides({});
    setError(null);
    setNotice(null);
  }

  /** Periksa file, with the given manual matches. A refused match (re-check) keeps the preview on
   * screen with its previous matches; a refused fresh check (wrong channel, missing column) clears it. */
  function check(nextOverrides: Record<string, string>, recheck: boolean) {
    const formData = formFor(nextOverrides);
    if (!formData) {
      setError("Pilih file export dulu.");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy("check");
    startTransition(async () => {
      const result = await call(() => previewImportAction(formData));
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        if (!recheck) setPreview(null);
        return;
      }
      setOverrides(nextOverrides);
      setPreview(result.data);
    });
  }

  function save() {
    if (!preview) return;
    const formData = formFor(overrides, preview.digest);
    if (!formData) return;
    setError(null);
    setNotice(null);
    setBusy("save");
    startTransition(async () => {
      const result = await call(() => commitImportAction(formData));
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const data = result.data;
      if (data.kind === "not_saved") {
        setPreview(data.preview);
        setNotice({ tone: "info", text: data.message });
        return;
      }
      const review = data.reviewCount > 0 ? ` ${formatNumber(data.reviewCount)} pesanan perlu dicek dan belum disimpan.` : "";
      const stale = data.storefrontOk ? "" : ` ${STOREFRONT_STALE_MESSAGE}`;
      setNotice({
        tone: "success",
        text: `${formatNumber(data.created + data.updated)} pesanan disimpan (${formatNumber(data.created)} baru, ${formatNumber(data.updated)} diperbarui).${review}${stale}`,
      });
      setPreview(null);
      setOverrides({});
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    });
  }

  const lockedOrBlocked = preview !== null && preview.saveBlockers.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          check({}, false);
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-900">Kanal</legend>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((option) => (
              <label key={option.id} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-neutral-300 px-3 has-[:checked]:border-brand has-[:checked]:bg-neutral-50">
                <input
                  type="radio"
                  name={channelName}
                  value={option.id}
                  checked={channel === option.id}
                  disabled={pending}
                  onChange={() => {
                    setChannel(option.id);
                    resetPreview();
                  }}
                  className="size-4 accent-brand"
                />
                <span className="text-base text-neutral-900">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fileInputId}>File export pesanan (.xlsx atau .csv, maks. 10 MB)</Label>
          <input
            ref={fileInput}
            id={fileInputId}
            type="file"
            accept=".xlsx,.csv"
            // A result that lands after the file changed would belong to the old file.
            disabled={pending}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              resetPreview();
            }}
            className="block w-full text-base text-neutral-900 file:mr-3 file:min-h-11 file:rounded-md file:border file:border-neutral-500 file:bg-white file:px-4 file:text-base file:font-medium file:text-neutral-700"
          />
          {file && (
            <p className="text-sm text-neutral-600" data-testid="import-file-name">
              {file.name} ({fileSizeText(file.size)})
            </p>
          )}
        </div>
        <div>
          <Button type="submit" loading={pending && busy === "check"} disabled={pending || !file}>
            Periksa file
          </Button>
        </div>
      </form>

      <div aria-live="polite" className="flex flex-col gap-2">
        {error && (
          <p className="rounded-md border border-danger-700/40 bg-danger-50 px-4 py-3 text-base text-neutral-900" data-testid="import-error">
            {error}
          </p>
        )}
        {notice && (
          <p className={`rounded-md border px-4 py-3 text-base text-neutral-900 ${notice.tone === "success" ? "border-success-700/40 bg-success-50" : "border-warning-700/40 bg-warning-50"}`} data-testid="import-notice">
            {notice.text}
          </p>
        )}
      </div>

      {preview && (
        <>
          <ImportPreview
            preview={preview}
            overrides={overrides}
            busy={pending}
            onMatch={setMatching}
            onUnmatch={(fileSku) => {
              const next = { ...overrides };
              delete next[fileSku];
              check(next, true);
            }}
          />
          <div className="flex flex-col gap-2">
            {lockedOrBlocked && (
              <ul className="flex flex-col gap-1 rounded-md border border-warning-700/40 bg-warning-50 px-4 py-3" data-testid="import-save-blockers">
                {preview.saveBlockers.map((blocker) => (
                  <li key={blocker} className="text-base text-neutral-900">
                    {blocker}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <Button type="button" onClick={save} loading={pending && busy === "save"} disabled={pending || !preview.canSave}>
                {`Simpan ${formatNumber(preview.saveCount)} pesanan`}
              </Button>
              {preview.counts.review > 0 && preview.canSave && <span className="text-sm text-neutral-600">Pesanan Perlu dicek tidak ikut disimpan.</span>}
            </div>
          </div>
        </>
      )}

      <SkuMatchDialog
        key={matching?.fileSku ?? "closed"}
        group={matching}
        onClose={() => setMatching(null)}
        onPick={(fileSku, adminSku) => {
          setMatching(null);
          check({ ...overrides, [fileSku]: adminSku }, true);
        }}
      />
    </div>
  );
}

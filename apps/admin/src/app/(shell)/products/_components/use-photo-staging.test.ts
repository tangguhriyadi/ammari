// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhotoStaging } from "./use-photo-staging";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const uploadProductImageAction = vi.fn();
const revalidateProductAction = vi.fn();
vi.mock("../actions", () => ({
  uploadProductImageAction: (formData: FormData) => uploadProductImageAction(formData),
  revalidateProductAction: (productId: string) => revalidateProductAction(productId),
}));

// The real downscaler needs createImageBitmap + <canvas>, neither available in jsdom — staging
// logic doesn't care what happens inside it, so it's stubbed to an identity "no resize happened"
// result, matching the real function's DownscaleResult shape.
vi.mock("@/lib/products/client-image-resize", () => ({
  downscaleImageForUpload: vi.fn(async (file: File) => ({ file, processed: false, timingMs: 0, inputBytes: file.size, outputBytes: file.size })),
}));

function makeFile(name: string, type = "image/jpeg", sizeBytes = 1024) {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

// A plain array-like stand-in — real FileList instances can't be constructed in jsdom, but
// Array.from (what addFiles uses to read the list) only needs `.length` + indexed access.
function makeFileList(files: File[]): FileList {
  return Object.assign({}, files, { length: files.length }) as unknown as FileList;
}

describe("usePhotoStaging", () => {
  beforeEach(() => {
    refresh.mockClear();
    uploadProductImageAction.mockReset();
    revalidateProductAction.mockReset();
    revalidateProductAction.mockResolvedValue({ ok: true, data: { revalidationOk: true } });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selecting files does not upload them — they stay staged until saveAll", async () => {
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("front.jpg")]));
    });

    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0]?.state).toBe("idle");
    expect(uploadProductImageAction).not.toHaveBeenCalled();
  });

  it("rejects a disallowed file type without staging it as uploadable", async () => {
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("doc.pdf", "application/pdf")]));
    });

    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0]?.state).toBe("error");
    expect(result.current.pending[0]?.error).toMatch(/JPEG, PNG, atau WebP/);
  });

  it("rejects a file over the 10 MB limit", async () => {
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("huge.jpg", "image/jpeg", 11 * 1024 * 1024)]));
    });

    expect(result.current.pending[0]?.state).toBe("error");
    expect(result.current.pending[0]?.error).toMatch(/10 MB/);
  });

  it("removeFile drops the file from the pending list", async () => {
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("front.jpg")]));
    });
    const localId = result.current.pending[0]!.localId;

    act(() => {
      result.current.removeFile(localId);
    });

    expect(result.current.pending).toHaveLength(0);
  });

  it("discardAll clears every staged file regardless of color group", async () => {
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("general.jpg")]));
      await result.current.addFiles("color-1", makeFileList([makeFile("sage.jpg")]));
    });
    expect(result.current.pending).toHaveLength(2);

    act(() => {
      result.current.discardAll();
    });

    expect(result.current.pending).toHaveLength(0);
  });

  it("saveAll uploads staged files and removes successes from the pending list, calling onSaved and router.refresh", async () => {
    uploadProductImageAction.mockResolvedValue({ ok: true, data: { id: "img-1" } });
    const onSaved = vi.fn();
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved }));

    await act(async () => {
      await result.current.addFiles("color-1", makeFileList([makeFile("sage.jpg")]));
    });

    let allSaved: boolean | undefined;
    await act(async () => {
      allSaved = await result.current.saveAll();
    });

    // The product stepper's "Lanjut" moves on only on true.
    expect(allSaved).toBe(true);
    expect(uploadProductImageAction).toHaveBeenCalledTimes(1);
    const sentFormData = uploadProductImageAction.mock.calls[0]![0] as FormData;
    expect(sentFormData.get("productId")).toBe("product-1");
    expect(sentFormData.get("fabricColorId")).toBe("color-1");
    expect(result.current.pending).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // ONE revalidation call for the whole batch (docs/plans/storefront-cms.md session 6), not
    // one per uploaded file.
    expect(revalidateProductAction).toHaveBeenCalledTimes(1);
    expect(revalidateProductAction).toHaveBeenCalledWith("product-1");
    expect(result.current.revalidationOk).toBe(true);
  });

  it("a failed upload stays in the pending list with its error, so it can be retried", async () => {
    uploadProductImageAction.mockResolvedValue({ ok: false, error: "Gagal mengunggah foto." });
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("front.jpg")]));
    });

    let allSaved: boolean | undefined;
    await act(async () => {
      allSaved = await result.current.saveAll();
    });

    expect(allSaved).toBe(false);
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0]?.state).toBe("error");
    expect(result.current.pending[0]?.error).toBe("Gagal mengunggah foto.");
    // Nothing actually uploaded — never fails the save, but never pays for a pointless
    // revalidation call either.
    expect(revalidateProductAction).not.toHaveBeenCalled();
  });

  it("surfaces revalidationOk:false (never failing the save itself) when the batch's revalidation call fails", async () => {
    uploadProductImageAction.mockResolvedValue({ ok: true, data: { id: "img-1" } });
    revalidateProductAction.mockResolvedValue({ ok: true, data: { revalidationOk: false } });
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("front.jpg")]));
    });
    await act(async () => {
      await result.current.saveAll();
    });

    expect(result.current.pending).toHaveLength(0); // the upload itself still succeeded
    expect(result.current.revalidationOk).toBe(false);

    revalidateProductAction.mockResolvedValue({ ok: true, data: { revalidationOk: true } });
    await act(async () => {
      await result.current.retryRevalidation();
    });
    expect(result.current.revalidationOk).toBe(true);
  });

  it("removing a file while saveAll is uploading an earlier one skips it instead of uploading it anyway", async () => {
    // A deferred first upload lets the test remove the SECOND file while the first is still
    // "in flight" — reproducing the race a react-review found: saveAll used to snapshot the
    // list once up front and upload every item in that snapshot regardless of what happened to
    // it afterward, so a file removed mid-save (its tile already gone from the UI) got silently
    // uploaded anyway once its turn came.
    let resolveFirstUpload!: (value: { ok: true; data: { id: string } }) => void;
    const firstUploadPromise = new Promise<{ ok: true; data: { id: string } }>((resolve) => {
      resolveFirstUpload = resolve;
    });
    uploadProductImageAction.mockReturnValueOnce(firstUploadPromise).mockResolvedValueOnce({ ok: true, data: { id: "img-2" } });

    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));
    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("first.jpg"), makeFile("second.jpg")]));
    });
    expect(result.current.pending).toHaveLength(2);
    const secondLocalId = result.current.pending[1]!.localId;

    let saveAllPromise!: Promise<boolean>;
    act(() => {
      saveAllPromise = result.current.saveAll();
    });
    // The first file's upload is now awaiting `firstUploadPromise` — remove the second file
    // before its turn comes.
    act(() => {
      result.current.removeFile(secondLocalId);
    });
    expect(result.current.pending).toHaveLength(1);

    // A second save while the first is still uploading (the product stepper's "Lanjut" right
    // after "Simpan foto") must not report "all saved", or the stepper would leave mid-upload.
    let secondSave: boolean | undefined;
    await act(async () => {
      secondSave = await result.current.saveAll();
    });
    expect(secondSave).toBe(false);

    await act(async () => {
      resolveFirstUpload({ ok: true, data: { id: "img-1" } });
      await saveAllPromise;
    });

    // Only the first file was ever uploaded — the removed second file must not have been sent.
    expect(uploadProductImageAction).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toHaveLength(0);
  });

  it("retrying saveAll only re-uploads the failed file, not ones already saved", async () => {
    uploadProductImageAction.mockResolvedValueOnce({ ok: false, error: "Gagal." }).mockResolvedValueOnce({ ok: true, data: { id: "img-2" } });
    const { result } = renderHook(() => usePhotoStaging({ productId: "product-1", onSaved: vi.fn() }));

    await act(async () => {
      await result.current.addFiles(null, makeFileList([makeFile("front.jpg")]));
    });
    await act(async () => {
      await result.current.saveAll();
    });
    expect(result.current.pending).toHaveLength(1);

    await act(async () => {
      await result.current.saveAll();
    });

    await waitFor(() => expect(result.current.pending).toHaveLength(0));
    expect(uploadProductImageAction).toHaveBeenCalledTimes(2);
  });
});

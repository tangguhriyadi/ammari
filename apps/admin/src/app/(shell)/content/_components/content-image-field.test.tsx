// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type UploadResult = { ok: true; data: { storageKey: string; width: number; height: number; previewUrl: string } };

// The upload resolves only when the test says so, so typing can happen while it is in flight.
let resolveUpload: (result: UploadResult) => void = () => {};
vi.mock("../actions", () => ({
  uploadContentImageAction: vi.fn(() => new Promise<UploadResult>((resolve) => (resolveUpload = resolve))),
}));
vi.mock("@/lib/products/client-image-resize", () => ({
  downscaleImageForUpload: vi.fn(async (file: File) => ({ file, inputBytes: file.size, outputBytes: file.size, timingMs: 1 })),
}));

import { ContentImageField, type ContentImageFieldValue } from "./content-image-field";

const crop = (key: string) => ({ storageKey: key, width: 1600, height: 900, previewUrl: `https://cdn.test/${key}.jpg` });
const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], "hero.jpg", { type: "image/jpeg" });

let latest: ContentImageFieldValue | null = null;

function Harness({ initial }: { initial: ContentImageFieldValue | null }) {
  const [value, setValue] = useState(initial);
  const change = (next: ContentImageFieldValue | null) => {
    latest = next;
    setValue(next);
  };
  return <ContentImageField sectionKey="hero" label="Gambar" value={value} onChange={change} allowMobileCrop />;
}

async function finishUpload(key: string) {
  await act(async () => {
    resolveUpload({ ok: true, data: crop(key) });
  });
}

beforeEach(() => {
  latest = null;
});

describe("ContentImageField: edits made while an upload is running are kept", () => {
  it("alt text typed during a desktop upload survives the upload finishing", async () => {
    render(<Harness initial={{ ...crop("old"), altText: "Lama", mobile: null }} />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("content-image-input-desktop"), { target: { files: [jpeg()] } });
    });
    fireEvent.change(screen.getByLabelText(/Teks alternatif/), { target: { value: "Model memakai gamis baru" } });
    await finishUpload("new");

    expect(latest).toMatchObject({ storageKey: "new", altText: "Model memakai gamis baru" });
    expect(screen.getByLabelText(/Teks alternatif/)).toHaveValue("Model memakai gamis baru");
  });

  it("alt text typed during a mobile crop upload survives too, and the crop is attached", async () => {
    render(<Harness initial={{ ...crop("desktop"), altText: "Lama", mobile: null }} />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("content-image-input-mobile"), { target: { files: [jpeg()] } });
    });
    fireEvent.change(screen.getByLabelText(/Teks alternatif/), { target: { value: "Diketik saat crop diunggah" } });
    await finishUpload("mobile");

    expect(latest).toMatchObject({ storageKey: "desktop", altText: "Diketik saat crop diunggah", mobile: { storageKey: "mobile" } });
  });

  it("a first upload into an empty field starts with empty alt text", async () => {
    render(<Harness initial={null} />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("content-image-input-desktop"), { target: { files: [jpeg()] } });
    });
    await finishUpload("first");

    expect(latest).toEqual({ ...crop("first"), altText: "", mobile: null });
  });
});

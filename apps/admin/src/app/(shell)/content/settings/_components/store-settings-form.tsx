"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label, Switch, Textarea, useToast } from "@ammari/ui";
import {
  ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH,
  HOMEPAGE_META_DESCRIPTION_DEFAULT,
  HOMEPAGE_META_DESCRIPTION_MAX_LENGTH,
  HOMEPAGE_META_DESCRIPTION_RECOMMENDED_LENGTH,
  HOMEPAGE_META_TITLE_DEFAULT,
  HOMEPAGE_META_TITLE_MAX_LENGTH,
  HOMEPAGE_META_TITLE_RECOMMENDED_LENGTH,
} from "@ammari/db/storefront-settings";
import { retryStorefrontRevalidationAction, saveStoreSettingsAction } from "../actions";

export interface StoreSettingsFormValues {
  whatsappNumber: string;
  supportEmail: string;
  businessAddress: string;
  returnPolicySummary: string;
  announcementBarEnabled: boolean;
  announcementBarText: string;
  homepageMetaTitle: string;
  homepageMetaDescription: string;
}

/** Live "n/limit" counter under a text field. Past `recommended` it turns amber and says why
 * (search results cut the text off), but it never blocks saving: only `max` (enforced by the
 * input's maxLength and by the server schema) is a hard limit. */
// Deliberately not an aria-live region: it is the field's aria-describedby target, read when the
// field is focused, and announcing it on every keystroke would drown out typing.
function CharacterCounter({ id, length, recommended, hint }: { id: string; length: number; recommended: number; hint?: string }) {
  const over = hint !== undefined && length > recommended;
  return (
    <p id={id} className={over ? "text-sm text-amber-800" : "text-sm text-neutral-600"}>
      {length}/{recommended} karakter{over ? `. ${hint}` : ""}
    </p>
  );
}

/** Save = live — one "Simpan" button, no draft/publish (docs/plans/storefront-cms.md Phase 2).
 * The WhatsApp number is normalized server-side (store-settings-schema.ts's
 * normalizeWhatsappNumber) — this form just passes through whatever format the owner typed. */
export function StoreSettingsForm({ initialValues }: { initialValues: StoreSettingsFormValues }) {
  const [values, setValues] = useState(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [revalidationOk, setRevalidationOk] = useState(true);
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function set<K extends keyof StoreSettingsFormValues>(key: K, value: StoreSettingsFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await saveStoreSettingsAction(values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRevalidationOk(result.data.revalidationOk);
      toast.success("Perubahan berhasil disimpan");
    });
  }

  function handleRetryRevalidation() {
    startTransition(async () => {
      const result = await retryStorefrontRevalidationAction();
      const ok = result.ok && result.data.revalidationOk;
      setRevalidationOk(ok);
      if (ok) toast.success("Toko online berhasil diperbarui");
      else toast.error("Toko online masih belum bisa diperbarui. Coba lagi nanti.");
    });
  }

  const announcementPreview = values.announcementBarText.replace(/\s+/g, " ").trim();

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <section aria-labelledby="settings-contact-heading" className="flex flex-col gap-4">
        <h2 id="settings-contact-heading" className="text-lg font-semibold text-neutral-900">
          Kontak toko
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-whatsapp">Nomor WhatsApp</Label>
          <Input
            id="settings-whatsapp"
            value={values.whatsappNumber}
            onChange={(event) => set("whatsappNumber", event.target.value)}
            placeholder="08xx-xxxx-xxxx"
            inputMode="tel"
          />
          <p className="text-sm text-neutral-600">Format apa pun boleh (08xx, +62xx, 62xx). Nomor disimpan otomatis dalam format yang benar.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-email">Email</Label>
          <Input id="settings-email" type="email" value={values.supportEmail} onChange={(event) => set("supportEmail", event.target.value)} placeholder="halo@ammari.id" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-address">Alamat</Label>
          <Textarea
            id="settings-address"
            value={values.businessAddress}
            onChange={(event) => set("businessAddress", event.target.value)}
            rows={3}
            maxLength={500}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-return-policy">Ringkasan kebijakan tukar/retur</Label>
          <Textarea
            id="settings-return-policy"
            value={values.returnPolicySummary}
            onChange={(event) => set("returnPolicySummary", event.target.value)}
            rows={2}
            maxLength={300}
            placeholder="mis. Tukar ukuran gratis dalam 3 hari"
          />
          <p className="text-sm text-neutral-600">Ditampilkan di halaman produk, pada baris &quot;Pengembalian &amp; penukaran&quot;.</p>
        </div>
      </section>

      <section aria-labelledby="settings-announcement-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="settings-announcement-heading" className="text-lg font-semibold text-neutral-900">
            Bar pengumuman
          </h2>
          <p className="text-sm text-neutral-600">Satu baris teks di atas menu, tampil di semua halaman toko online.</p>
        </div>
        <Switch
          checked={values.announcementBarEnabled}
          onCheckedChange={(checked) => set("announcementBarEnabled", checked)}
          label="Tampilkan bar pengumuman"
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-announcement-text">Teks pengumuman</Label>
          <Input
            id="settings-announcement-text"
            value={values.announcementBarText}
            onChange={(event) => set("announcementBarText", event.target.value)}
            maxLength={ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH}
            aria-describedby="settings-announcement-count"
            placeholder="mis. Subsidi Ongkir hingga Rp20.000"
          />
          <CharacterCounter
            id="settings-announcement-count"
            length={announcementPreview.length}
            recommended={ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH}
          />
          <p className="text-sm text-neutral-600">
            Maksimal {ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH} karakter agar muat satu baris di HP. Kosongkan atau matikan untuk menyembunyikan bar.
          </p>
        </div>
        {values.announcementBarEnabled && announcementPreview && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-neutral-600">Pratinjau</span>
            <div
              data-testid="announcement-bar-preview"
              className="flex h-9 items-center justify-center rounded-md bg-brand px-4 text-white"
            >
              <span className="truncate text-[11px] font-medium tracking-[0.12em] uppercase">{announcementPreview}</span>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="settings-homepage-meta-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="settings-homepage-meta-heading" className="text-lg font-semibold text-neutral-900">
            Judul dan deskripsi beranda
          </h2>
          <p className="text-sm text-neutral-600">
            Tampil di hasil pencarian Google dan saat tautan beranda dibagikan di WhatsApp atau media sosial. Kosongkan untuk memakai teks bawaan.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-homepage-meta-title">Judul beranda</Label>
          <Input
            id="settings-homepage-meta-title"
            value={values.homepageMetaTitle}
            onChange={(event) => set("homepageMetaTitle", event.target.value)}
            maxLength={HOMEPAGE_META_TITLE_MAX_LENGTH}
            aria-describedby="settings-homepage-meta-title-count"
            placeholder={HOMEPAGE_META_TITLE_DEFAULT}
          />
          <CharacterCounter
            id="settings-homepage-meta-title-count"
            length={values.homepageMetaTitle.length}
            recommended={HOMEPAGE_META_TITLE_RECOMMENDED_LENGTH}
            hint="Google biasanya memotong judul setelah sekitar 60 karakter."
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-homepage-meta-description">Deskripsi beranda</Label>
          <Textarea
            id="settings-homepage-meta-description"
            value={values.homepageMetaDescription}
            onChange={(event) => set("homepageMetaDescription", event.target.value)}
            rows={3}
            maxLength={HOMEPAGE_META_DESCRIPTION_MAX_LENGTH}
            aria-describedby="settings-homepage-meta-description-count"
            placeholder={HOMEPAGE_META_DESCRIPTION_DEFAULT}
          />
          <CharacterCounter
            id="settings-homepage-meta-description-count"
            length={values.homepageMetaDescription.length}
            recommended={HOMEPAGE_META_DESCRIPTION_RECOMMENDED_LENGTH}
            hint="Google biasanya memotong deskripsi setelah sekitar 160 karakter."
          />
        </div>
      </section>

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}

      {!revalidationOk && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-amber-800" data-testid="revalidation-warning">
          Perubahan tersimpan, tetapi toko online belum diperbarui.
          <button type="button" onClick={handleRetryRevalidation} disabled={pending} className="font-medium underline disabled:opacity-60">
            Coba lagi
          </button>
        </p>
      )}

      <div className="flex justify-end">
        <Button type="button" onClick={handleSave} loading={pending}>
          Simpan
        </Button>
      </div>
    </div>
  );
}

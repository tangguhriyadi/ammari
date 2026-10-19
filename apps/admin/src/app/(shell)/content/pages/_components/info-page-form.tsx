"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, Input, Label, useToast } from "@ammari/ui";
import type { InfoPageSlug } from "@ammari/db/schema";
import { RichTextEditor } from "@/app/(shell)/products/_components/rich-text-editor";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { discardInfoPageDraftAction, publishInfoPageAction, saveInfoPageDraftAction } from "../../actions";
import { UnpublishedChangesBanner } from "../../_components/unpublished-changes-banner";

export interface InfoPageFormValues {
  title: string;
  bodyHtml: string;
}

/** One page's own editor — draft save, publish, and discard all live HERE (not a separate
 * top-level action the way the homepage's atomic "Terbitkan" does), since each info page
 * publishes independently (docs/plans/storefront-cms.md session 8). */
export function InfoPageForm({
  slug,
  initialValues,
  isPublished,
  initialHasUnpublishedChanges,
}: {
  slug: InfoPageSlug;
  initialValues: InfoPageFormValues;
  isPublished: boolean;
  initialHasUnpublishedChanges: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState(initialValues);
  const [publishedState, setPublishedState] = useState(isPublished);
  const [savedValues, setSavedValues] = useState(initialValues);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(initialHasUnpublishedChanges);
  const [error, setError] = useState<string | null>(null);
  const [savePending, startSave] = useTransition();
  const [publishPending, startPublish] = useTransition();
  const [discardPending, startDiscard] = useTransition();
  // TipTap's `useEditor({ content })` only applies `content` ONCE, at mount — updating `values`
  // state alone (e.g. after a discard resets it server-side) never changes what the already-
  // mounted editor shows. Bumping this key on every discard forces RichTextEditor to unmount and
  // remount with the new content, same remount trick the login forms use for their OTP input
  // (`key={sentAt}`).
  const [editorKey, setEditorKey] = useState(0);

  const hasUnsavedEdits = values.title !== savedValues.title || values.bodyHtml !== savedValues.bodyHtml;
  useUnsavedChangesGuard(hasUnsavedEdits);

  function handleSave() {
    setError(null);
    startSave(async () => {
      const result = await saveInfoPageDraftAction(slug, values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedValues(values);
      if (publishedState) setHasUnpublishedChanges(true);
      // Stays on the editor (no redirect to /content/pages): save draft -> Terbitkan and the
      // unpublished-changes banner all live on this page, so leaving it would break that flow.
      toast.success("Perubahan berhasil disimpan");
      router.refresh();
    });
  }

  function handlePublish() {
    setError(null);
    startPublish(async () => {
      const result = await publishInfoPageAction(slug);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPublishedState(true);
      setHasUnpublishedChanges(false);
    });
  }

  function handleDiscard() {
    setError(null);
    startDiscard(async () => {
      const result = await discardInfoPageDraftAction(slug);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const resetValues = { title: values.title, bodyHtml: result.data.bodyHtml };
      setValues(resetValues);
      setSavedValues(resetValues);
      setHasUnpublishedChanges(false);
      setEditorKey((key) => key + 1);
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {publishedState && hasUnpublishedChanges && (
        <UnpublishedChangesBanner onPublish={handlePublish} pending={publishPending} disabled={hasUnsavedEdits} testId="info-page-unpublished-banner">
          Ada perubahan yang belum diterbitkan. Pengunjung masih melihat versi lama.
        </UnpublishedChangesBanner>
      )}

      {!publishedState && (
        <Card className="border-brand bg-brand/5">
          <p className="text-base text-neutral-900">Halaman ini belum pernah diterbitkan. Pengunjung melihat status &quot;sedang disiapkan&quot;.</p>
        </Card>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="info-page-title" required>
          Judul
        </Label>
        <Input
          id="info-page-title"
          value={values.title}
          onChange={(event) => setValues((prev) => ({ ...prev, title: event.target.value }))}
          maxLength={100}
          required
        />
      </div>

      <RichTextEditor
        key={editorKey}
        id="info-page-body"
        label="Konten"
        content={values.bodyHtml}
        onChange={(html) => setValues((prev) => ({ ...prev, bodyHtml: html }))}
        allowHeading
        disabled={savePending || publishPending || discardPending}
        data-testid="info-page-body-editor"
      />

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2" data-testid="info-page-actions">
        <Button type="button" variant="secondary" onClick={handleDiscard} loading={discardPending} disabled={!publishedState}>
          Batalkan perubahan
        </Button>
        <Button type="button" variant="secondary" onClick={handleSave} loading={savePending}>
          Simpan draf
        </Button>
        <Button type="button" onClick={handlePublish} loading={publishPending} disabled={hasUnsavedEdits}>
          Terbitkan
        </Button>
      </div>
      {hasUnsavedEdits && <p className="text-right text-sm text-neutral-600">Simpan draf dulu sebelum menerbitkan.</p>}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button, Input, Label, Switch, Textarea, useToast } from "@ammari/ui";
import { WHY_AMMARI_ICON_KEYS, type WhyAmmariIconKey } from "@ammari/db/why-ammari";
import { HOMEPAGE_SECTION_LABELS, unpublishedSectionsBannerText } from "@/lib/content/homepage-types";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { publishHomepageAction, saveWhyAmmariDraftAction } from "../actions";
import { WhyAmmariIconPicker } from "./why-ammari-icon-picker";
import { UnpublishedChangesBanner } from "./unpublished-changes-banner";

const SECTION_LABEL = HOMEPAGE_SECTION_LABELS.why_ammari;

const MAX_POINTS = 4;

export interface WhyAmmariPointValues {
  icon: WhyAmmariIconKey;
  title: string;
  text: string;
}

export interface WhyAmmariFormValues {
  isVisible: boolean;
  eyebrow: string;
  heading: string;
  points: WhyAmmariPointValues[];
}

function emptyPoint(): WhyAmmariPointValues {
  return { icon: WHY_AMMARI_ICON_KEYS[0], title: "", text: "" };
}

export function WhyAmmariForm({
  initialValues,
  initialUnpublishedSectionLabels,
}: {
  initialValues: WhyAmmariFormValues;
  initialUnpublishedSectionLabels: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState(initialValues);
  const [savedValues, setSavedValues] = useState(initialValues);
  const [unpublishedSectionLabels, setUnpublishedSectionLabels] = useState(initialUnpublishedSectionLabels);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [publishPending, startPublishTransition] = useTransition();

  const dirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  useUnsavedChangesGuard(dirty);

  function updatePoint(index: number, patch: Partial<WhyAmmariPointValues>) {
    setValues((prev) => ({
      ...prev,
      points: prev.points.map((point, candidateIndex) => (candidateIndex === index ? { ...point, ...patch } : point)),
    }));
  }

  function addPoint() {
    setValues((prev) => (prev.points.length >= MAX_POINTS ? prev : { ...prev, points: [...prev.points, emptyPoint()] }));
  }

  function removePoint(index: number) {
    setValues((prev) => ({ ...prev, points: prev.points.filter((_, candidateIndex) => candidateIndex !== index) }));
  }

  function handleSave() {
    setFormError(null);
    startTransition(async () => {
      const result = await saveWhyAmmariDraftAction({
        isVisible: values.isVisible,
        content: { eyebrow: values.eyebrow, heading: values.heading, points: values.points },
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setSavedValues(values);
      setUnpublishedSectionLabels((prev) => (prev.includes(SECTION_LABEL) ? prev : [...prev, SECTION_LABEL]));
      toast.success("Perubahan berhasil disimpan");
      router.refresh();
    });
  }

  function handlePublish() {
    setFormError(null);
    startPublishTransition(async () => {
      const result = await publishHomepageAction();
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setUnpublishedSectionLabels([]);
      toast.success("Beranda berhasil diterbitkan");
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {unpublishedSectionLabels.length > 0 && (
        <UnpublishedChangesBanner onPublish={handlePublish} pending={publishPending} disabled={dirty} testId="why-ammari-unpublished-banner">
          {unpublishedSectionsBannerText(unpublishedSectionLabels)}
        </UnpublishedChangesBanner>
      )}

      <Switch label="Tayang" checked={values.isVisible} onCheckedChange={(checked) => setValues((prev) => ({ ...prev, isVisible: checked }))} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="why-ammari-eyebrow">Eyebrow</Label>
        <Input
          id="why-ammari-eyebrow"
          value={values.eyebrow}
          onChange={(event) => setValues((prev) => ({ ...prev, eyebrow: event.target.value }))}
          maxLength={60}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="why-ammari-heading" required>
          Judul
        </Label>
        <Input
          id="why-ammari-heading"
          value={values.heading}
          onChange={(event) => setValues((prev) => ({ ...prev, heading: event.target.value }))}
          maxLength={100}
          required
        />
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-base text-neutral-900">
          Poin ({values.points.length}/{MAX_POINTS})
        </span>
        {values.points.map((point, index) => (
          <div key={index} className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-neutral-700">Poin {index + 1}</span>
              <button
                type="button"
                aria-label={`Hapus poin ${index + 1}`}
                onClick={() => removePoint(index)}
                className="flex size-11 items-center justify-center rounded-md text-danger-700 hover:bg-danger-50"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>

            <WhyAmmariIconPicker name={`point-${index}`} value={point.icon} onChange={(icon) => updatePoint(index, { icon })} />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`why-ammari-point-title-${index}`} required>
                Judul poin
              </Label>
              <Input
                id={`why-ammari-point-title-${index}`}
                value={point.title}
                onChange={(event) => updatePoint(index, { title: event.target.value })}
                maxLength={60}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`why-ammari-point-text-${index}`} required>
                Teks poin
              </Label>
              <Textarea
                id={`why-ammari-point-text-${index}`}
                value={point.text}
                onChange={(event) => updatePoint(index, { text: event.target.value })}
                rows={2}
                maxLength={160}
                required
              />
            </div>
          </div>
        ))}

        <Button type="button" variant="secondary" onClick={addPoint} disabled={values.points.length >= MAX_POINTS}>
          Tambah poin
        </Button>
      </div>

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
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

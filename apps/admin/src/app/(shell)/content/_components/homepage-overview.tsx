"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button, Card, Switch } from "@ammari/ui";
import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_SECTION_ROUTES,
  sectionHasUnpublishedChanges,
  type HomepageSectionRow,
} from "@/lib/content/homepage-types";
import { discardHomepageDraftAction, publishHomepageAction, setHomepageSectionVisibilityAction } from "../actions";

/** The /content overview — a persistent "Ada perubahan belum diterbitkan" banner (visible the
 * moment ANY section's draft differs from what's live) with a single atomic "Terbitkan", plus
 * each section's own quick visibility toggle (docs/plans/storefront-cms.md's "Admin UX"). Each
 * section's own text/tiles/points are edited on its own page (HOMEPAGE_SECTION_ROUTES below),
 * never here — this page only ever touches `draft_is_visible` directly. */
export function HomepageOverview({ initialSections }: { initialSections: HomepageSectionRow[] }) {
  const [sections, setSections] = useState(initialSections);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [visibilityPending, startVisibilityTransition] = useTransition();
  const [publishPending, startPublish] = useTransition();
  const [discardPending, startDiscard] = useTransition();

  const hasChanges = sections.some(sectionHasUnpublishedChanges);

  function handleToggleVisibility(key: HomepageSectionRow["key"], nextVisible: boolean) {
    setError(null);
    setPendingKey(key);
    startVisibilityTransition(async () => {
      const result = await setHomepageSectionVisibilityAction(key, nextVisible);
      setPendingKey(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSections((prev) => prev.map((section) => (section.key === key ? { ...section, draftIsVisible: nextVisible } : section)));
    });
  }

  function handlePublish() {
    setError(null);
    startPublish(async () => {
      const result = await publishHomepageAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Updated locally, not via router.refresh() + re-reading the server's fresh props: this
      // component's `sections` state was seeded from `initialSections` on FIRST mount only
      // (useState's initial value is ignored on every later render), so a server refetch alone
      // would never actually reach this already-mounted client component's own state — the
      // banner would keep showing even though the publish genuinely succeeded. The new
      // published values are exactly the draft values that were just promoted, so they're known
      // here without another round trip.
      const publishedAt = new Date();
      setSections((prev) =>
        prev.map((section) => ({
          ...section,
          publishedContent: section.draftContent,
          publishedIsVisible: section.draftIsVisible,
          publishedAt,
        })),
      );
    });
  }

  function handleDiscard() {
    setError(null);
    startDiscard(async () => {
      const result = await discardHomepageDraftAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Same "update local state directly" reasoning as handlePublish above.
      setSections((prev) =>
        prev.map((section) => ({
          ...section,
          draftContent: section.publishedContent ?? {},
          draftIsVisible: section.publishedIsVisible ?? true,
        })),
      );
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {hasChanges && (
        <Card className="flex flex-col gap-3 border-brand bg-brand/5 sm:flex-row sm:items-center sm:justify-between" data-testid="unpublished-changes-banner">
          <p className="text-base text-neutral-900">Ada perubahan yang belum diterbitkan.</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleDiscard} loading={discardPending}>
              Batalkan perubahan
            </Button>
            <Button onClick={handlePublish} loading={publishPending}>
              Terbitkan
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {sections.map((section) => (
          <Card key={section.key} className="flex items-center justify-between gap-3" data-testid={`homepage-section-row-${section.key}`}>
            <Link
              href={HOMEPAGE_SECTION_ROUTES[section.key]}
              className="flex-1 text-base font-medium text-neutral-900 hover:underline"
            >
              {HOMEPAGE_SECTION_LABELS[section.key]}
            </Link>
            <Switch
              label="Tayang"
              accessibleLabel={`Tayang — ${HOMEPAGE_SECTION_LABELS[section.key]}`}
              checked={section.draftIsVisible}
              onCheckedChange={(checked) => handleToggleVisibility(section.key, checked)}
              pending={visibilityPending && pendingKey === section.key}
            />
          </Card>
        ))}
      </div>
    </div>
  );
}

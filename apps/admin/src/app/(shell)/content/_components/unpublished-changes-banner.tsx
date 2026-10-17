"use client";

import type { ReactNode } from "react";
import { Button, Card } from "@ammari/ui";

/** The "Ada perubahan belum diterbitkan" banner, reused on every draft/publish editor (each
 * homepage section's own page, and each Info Page's own page) — not just the /content overview,
 * which already had its own copy of this same look. `children` carries the exact Indonesian
 * copy, since the homepage sections (atomic publish, naming which sections are affected) and
 * Info Pages (independent per-page publish) need different wording. */
export function UnpublishedChangesBanner({
  children,
  onPublish,
  pending,
  disabled = false,
  testId,
}: {
  children: ReactNode;
  onPublish: () => void;
  pending: boolean;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <Card
      className="flex flex-col gap-3 border-brand bg-brand/5 sm:flex-row sm:items-center sm:justify-between"
      data-testid={testId}
    >
      <p className="text-base text-neutral-900">{children}</p>
      <Button type="button" onClick={onPublish} loading={pending} disabled={disabled}>
        Terbitkan
      </Button>
    </Card>
  );
}

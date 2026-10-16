"use client";

import Link from "next/link";
import { Badge, Card } from "@ammari/ui";
import { INFO_PAGE_LABELS, INFO_PAGE_ROUTES, infoPageHasUnpublishedChanges, type InfoPageRow } from "@/lib/content/info-pages-types";

/** The /content/pages list — unlike the homepage overview, there's no top-level "Terbitkan" here:
 * each page publishes independently from its own editor (docs/plans/storefront-cms.md session
 * 8's "own draft/publish per page" decision). This page only ever shows status, it never writes
 * anything itself. */
export function InfoPagesOverview({ initialPages }: { initialPages: InfoPageRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      {initialPages.map((page) => {
        const isPublished = page.publishedBody !== null;
        const hasChanges = infoPageHasUnpublishedChanges(page);
        return (
          <Card key={page.slug} className="flex items-center justify-between gap-3" data-testid={`info-page-row-${page.slug}`}>
            <Link href={INFO_PAGE_ROUTES[page.slug]} className="flex-1 text-base font-medium text-neutral-900 hover:underline">
              {INFO_PAGE_LABELS[page.slug]}
            </Link>
            <div className="flex items-center gap-2">
              {hasChanges && <Badge variant="neutral">Belum diterbitkan</Badge>}
              <Badge variant={isPublished ? "success" : "neutral"}>{isPublished ? "Tayang" : "Sedang disiapkan"}</Badge>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

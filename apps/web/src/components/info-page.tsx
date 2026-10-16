import { sanitizeInfoPageHtml } from "@ammari/content-sanitize";

/** Shared by all 5 info-page routes (docs/plans/storefront-cms.md Phase 2, session 8) — renders
 * the published body if there is one, or a polite "sedang disiapkan" state otherwise (never a
 * 500, never a blank page). Sanitized AGAIN here, independently, immediately before
 * `dangerouslySetInnerHTML` — defense in depth, same posture the PDP's own "Deskripsi" accordion
 * already takes for the storefront description. */
export function InfoPageBody({ title, body }: { title: string; body: string | null }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">{title}</h1>
      {body ? (
        <div
          className="flex flex-col gap-3 text-sm text-ink-soft [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-ink [&_li]:ml-5 [&_ol]:list-decimal [&_strong]:font-medium [&_ul]:list-disc"
          dangerouslySetInnerHTML={{ __html: sanitizeInfoPageHtml(body) }}
        />
      ) : (
        <p className="text-sm text-ink-muted">Halaman ini sedang disiapkan. Silakan kembali lagi nanti.</p>
      )}
    </div>
  );
}

// ---------- Content image reference extraction (pure, no DB/storage) ----------
//
// Deliberately NOT in content-image-queries.ts (which has `import "server-only"` and pulls in
// the storage client) — this is pure JSON inspection, used by homepage.ts purely to DIFF two
// content snapshots and decide which storage keys are safe to delete (docs/plans/
// storefront-cms.md session 5's draft/publish reference-safety rule: "only delete storage
// objects when nothing references them anymore"). Kept separate so it can be unit-tested with no
// DB/storage setup at all.

/** Every storage key one section's `*_content` JSONB currently references — only hero/
 * feature_block have an `image` field at all (product_grid/why_ammari, and the seeded `{}`
 * default before a section is ever saved, simply have none, so this returns `[]` for them).
 * Tolerant of any shape (bad/partial/legacy content) — this only ever widens "what to keep", so
 * treating anything unrecognized as "no key" is the safe direction: it can at worst leave an
 * orphan for a later sweep, never delete something still in use. */
export function extractContentImageKeys(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const image = (content as Record<string, unknown>).image;
  if (!image || typeof image !== "object") return [];
  const record = image as Record<string, unknown>;

  const keys: string[] = [];
  if (typeof record.storageKey === "string" && record.storageKey.length > 0) keys.push(record.storageKey);
  if (typeof record.mobileStorageKey === "string" && record.mobileStorageKey.length > 0) keys.push(record.mobileStorageKey);
  return keys;
}

/** Keys present in `before` but absent from EVERY content snapshot in `keep` — the set that's
 * now safe to delete from storage. */
export function diffOrphanedContentImageKeys(before: unknown, ...keep: unknown[]): string[] {
  const beforeKeys = extractContentImageKeys(before);
  const keptKeys = new Set(keep.flatMap((content) => extractContentImageKeys(content)));
  return beforeKeys.filter((key) => !keptKeys.has(key));
}

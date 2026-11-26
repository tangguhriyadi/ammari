import { Badge } from "@ammari/ui";

export const SYSTEM_BADGE_HINT = "Dipakai perhitungan ROAS/laporan, tidak bisa dinonaktifkan";
/** The same sentence after "Kategori sistem: " (only the first letter lowercased, ROAS stays). */
export const SYSTEM_BADGE_HINT_INLINE = "dipakai perhitungan ROAS/laporan, tidak bisa dinonaktifkan";

/** Plan §3.6: the tooltip says why it can't be deactivated; the sr-only text says it to a
 * screen reader too, since `title` alone is not reliably announced. */
export function SystemBadge() {
  return (
    <Badge variant="neutral" title={SYSTEM_BADGE_HINT}>
      Sistem<span className="sr-only">: {SYSTEM_BADGE_HINT}</span>
    </Badge>
  );
}

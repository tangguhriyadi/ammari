/** Merges a field's own error id into whatever `aria-describedby` the caller already passed,
 * instead of one silently replacing the other (a caller-supplied id — e.g. linked help text —
 * must survive even once the field also has a validation error). */
export function mergeDescribedBy(
  callerDescribedBy: string | undefined,
  errorId: string | undefined,
): string | undefined {
  // Taken out of the props by each field component, so its `{...props}` spread can never put the
  // caller's value back over the merged one. Deduplicated: some callers already list the error id.
  const ids = [...new Set([...(callerDescribedBy?.split(/\s+/) ?? []), errorId].filter((id): id is string => Boolean(id)))];
  return ids.length > 0 ? ids.join(" ") : undefined;
}

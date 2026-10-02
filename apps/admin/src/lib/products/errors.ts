/** Thrown by a `lib/products` query function when a write fails validation in a way the UI
 * should show next to a specific field, rather than as a generic error. */
export class FieldError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "FieldError";
  }
}

/** Thrown when a write is refused for a reason that isn't tied to one form field (e.g. deleting
 * a fabric still used by products). */
export class ActionError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

interface PostgresErrorShape {
  code?: string;
  constraint_name?: string;
}

function isPostgresError(error: unknown): error is PostgresErrorShape {
  return typeof error === "object" && error !== null && "code" in error;
}

/** `error.cause`, when present and set, is checked before `error` itself — same defensive
 * fallback order as mapUniqueViolation (see its doc comment for why `.cause` is checked at all). */
export function isPostgresErrorCode(error: unknown, code: string): boolean {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return isPostgresError(cause) && cause.code === code;
}

/** Maps a Postgres unique-violation (23505) on a known constraint name to a friendly FieldError.
 * Never pre-checks "does this already exist" — the unique constraint is the source of truth
 * (CLAUDE.md); this only runs AFTER an insert/update has already failed. Rethrows anything it
 * doesn't recognize (including non-unique-violation errors) so callers never swallow a real bug.
 *
 * postgres.js attaches `code`/`constraint_name` directly onto the `PostgresError` it throws —
 * drizzle-orm's postgres-js driver does NOT wrap it in `.cause` (only its sqlite driver does
 * that, confirmed by reading both drivers' source). The `.cause` check below only exists in case
 * something upstream ever starts wrapping it that way; the common case is `error` itself already
 * being the Postgres error, which the `: error` fallback handles. */
export function mapUniqueViolation(error: unknown, constraintFieldMap: Record<string, { field: string; message: string }>): never {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (isPostgresError(cause) && cause.code === "23505" && cause.constraint_name) {
    const mapped = constraintFieldMap[cause.constraint_name];
    if (mapped) throw new FieldError(mapped.field, mapped.message);
  }
  throw error;
}

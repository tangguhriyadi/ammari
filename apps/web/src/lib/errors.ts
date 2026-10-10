/** Mirrors apps/admin's own lib/errors.ts (same Postgres error shape, same reasoning) — kept
 * local rather than shared, since this app only needs the one unique-violation check below, not
 * admin's full FieldError/ActionError/mapUniqueViolation machinery. */
interface PostgresErrorShape {
  code?: string;
  constraint_name?: string;
}

function isPostgresError(error: unknown): error is PostgresErrorShape {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Never pre-checks "does this phone already exist" — the unique constraint is the source of
 * truth (CLAUDE.md); this only runs AFTER a write has already failed. postgres.js attaches
 * `code`/`constraint_name` directly onto the error it throws (not wrapped in `.cause` — see
 * admin's own lib/errors.ts for the fuller explanation of the `.cause` fallback). */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return isPostgresError(cause) && cause.code === "23505" && cause.constraint_name === constraintName;
}

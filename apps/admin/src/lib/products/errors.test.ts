import { describe, expect, test } from "vitest";
import { ActionError, FieldError, mapUniqueViolation } from "./errors";

/** The actual runtime shape: postgres.js attaches `code`/`constraint_name` directly onto the
 * `PostgresError` it throws — confirmed by reading node_modules/postgres's error-field parsing
 * and drizzle-orm's postgres-js driver, which does NOT wrap it in `.cause` (only its separate
 * sqlite driver does that). This is the shape `mapUniqueViolation` sees in production. */
function rawPostgresUniqueViolation(constraintName: string): Error & { code: string; constraint_name: string } {
  const error = new Error(`Failed query: insert into "products" ...`) as Error & {
    code: string;
    constraint_name: string;
  };
  error.code = "23505";
  error.constraint_name = constraintName;
  return error;
}

/** A hypothetical wrapped shape (`.cause` holding the real error) — not what actually happens on
 * this stack today, but `mapUniqueViolation` checks `.cause` defensively in case something
 * upstream ever does wrap it that way, so this path stays covered too. */
function causeWrappedPostgresUniqueViolation(constraintName: string): Error {
  const error = new Error(`Failed query: insert into "products" ...`);
  (error as unknown as { cause: unknown }).cause = { code: "23505", constraint_name: constraintName };
  return error;
}

describe("mapUniqueViolation", () => {
  const FIELD_MAP = {
    products_slug_unique: { field: "slug", message: "Slug ini sudah dipakai." },
  };

  test("maps a known constraint to a FieldError (actual unwrapped postgres.js error shape)", () => {
    expect(() => mapUniqueViolation(rawPostgresUniqueViolation("products_slug_unique"), FIELD_MAP)).toThrow(FieldError);
  });

  test("also maps a known constraint when the error is `.cause`-wrapped (defensive fallback path)", () => {
    expect(() => mapUniqueViolation(causeWrappedPostgresUniqueViolation("products_slug_unique"), FIELD_MAP)).toThrow(
      FieldError,
    );
  });

  test("the thrown FieldError carries the field name and friendly message", () => {
    try {
      mapUniqueViolation(rawPostgresUniqueViolation("products_slug_unique"), FIELD_MAP);
      throw new Error("expected mapUniqueViolation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe("slug");
      expect((error as FieldError).message).toBe("Slug ini sudah dipakai.");
    }
  });

  test("rethrows the original error for an unrecognized constraint", () => {
    const original = rawPostgresUniqueViolation("some_other_constraint");
    expect(() => mapUniqueViolation(original, FIELD_MAP)).toThrow(original);
  });

  test("rethrows a non-unique-violation error untouched", () => {
    const notAUniqueViolation = new Error("connection reset");
    expect(() => mapUniqueViolation(notAUniqueViolation, FIELD_MAP)).toThrow(notAUniqueViolation);
  });
});

describe("ActionError", () => {
  test("carries an optional detail payload", () => {
    const error = new ActionError("Bahan ini masih dipakai.", { usedByCount: 2 });
    expect(error.message).toBe("Bahan ini masih dipakai.");
    expect(error.detail).toEqual({ usedByCount: 2 });
  });
});

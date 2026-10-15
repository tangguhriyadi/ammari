import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Replaces the `drizzle-kit migrate` CLI (run via `pnpm db:migrate`, and by the deploy
// pipeline's migrator image — docs/deploy.md). The CLI swallows the real Postgres error: on a
// real failure it printed only "applying migrations..." then exited 1, even attached to a TTY —
// discovered during the first real dev deploy, where the actual cause only showed up by running
// the migration programmatically like this instead. `max: 1` — this is a one-shot script, never
// a pool.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const sql = postgres(DATABASE_URL, { max: 1 });

async function main(): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully.");
}

// NEVER the connection string (DATABASE_URL embeds the password) — only fields that describe
// what went wrong. `postgres`'s own PostgresError carries the real Postgres error fields
// (code/detail/hint/...) directly on the error object; a connection-level failure
// (ECONNREFUSED, ENOTFOUND, ...) carries a different but equally non-sensitive set
// (code/address/port/syscall) instead — neither shape includes the connection string itself.
// Drizzle's own migrate() wraps whichever of those in a `DrizzleQueryError` whose OWN message
// is just "Failed query: ..." with the real cause one level down in `.cause` — confirmed by
// provoking a real connection failure and inspecting it directly; printing only the top-level
// error (what the first version of this script did) hid the actual reason behind a useless
// "Failed query" message.
const RELEVANT_FIELDS = [
  "code",
  "detail",
  "hint",
  "severity",
  "schema_name",
  "table_name",
  "column_name",
  "constraint_name",
  "address",
  "port",
  "syscall",
  "errno",
] as const;

function logErrorFields(error: unknown, label: string): void {
  if (!(error instanceof Error)) {
    console.error(`${label}: ${String(error)}`);
    return;
  }
  console.error(`${label} message: ${error.message}`);
  for (const field of RELEVANT_FIELDS) {
    const value = (error as unknown as Record<string, unknown>)[field];
    if (value !== undefined) console.error(`${label} ${field}: ${value}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error("Migration failed.");
    logErrorFields(error, "error");
    if (error instanceof Error && error.cause) {
      logErrorFields(error.cause, "caused by");
    }
    process.exitCode = 1;
  })
  .finally(() => sql.end());

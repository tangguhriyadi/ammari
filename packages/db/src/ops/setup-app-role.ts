import postgres from "postgres";
import { appRoleProblems, setupAppRole } from "./app-role";

// One-time setup (and password rotation) of the apps' database role (docs/plans/accounting.md
// runbook R1). Run BY HAND through the migrator image, as the table owner:
//
//   docker run --rm [--network ...] --env-file env/migrator.env -e APP_DB_PASSWORD \
//     <migrator image> node_modules/.bin/tsx src/ops/setup-app-role.ts
//
// with APP_DB_ROLE in env/migrator.env and APP_DB_PASSWORD exported in the calling shell only for
// that command (read from a file, never typed on the command line). Idempotent: re-running it
// re-applies the grants; with APP_DB_PASSWORD it also sets that password. Ends with the same
// verification as check-app-role.ts. Never prints the password or the connection string.

const url = process.env.DATABASE_URL;
const appRole = process.env.APP_DB_ROLE?.trim() ?? "";
const password = process.env.APP_DB_PASSWORD?.trim() || null;
if (!url || appRole === "") {
  console.error("setup-app-role: DATABASE_URL (the table owner) and APP_DB_ROLE must be set");
  process.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
let exitCode = 0;
try {
  for (const line of await setupAppRole(sql, appRole, password)) console.log(`setup-app-role: ${line}`);
  const problems = await appRoleProblems(sql, appRole);
  if (problems.length === 0) console.log(`setup-app-role: PASS ${appRole} is ready`);
  for (const problem of problems) console.error(`setup-app-role: FAIL ${problem}`);
  if (problems.length > 0) exitCode = 1;
} catch (error) {
  console.error(`setup-app-role: failed: ${(error as Error).message}`);
  exitCode = 2;
} finally {
  await sql.end();
}
process.exit(exitCode);

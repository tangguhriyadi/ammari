import postgres from "postgres";
import { appConnectionProblems, appRoleProblems, assertRoleName } from "./app-role";

// The verification check for the app database role (docs/plans/accounting.md runbook R1): run by
// deploy/remote-deploy.sh and deploy-prod/remote-deploy.sh after the migrations, through the migrator
// image, with env/migrator.env (DATABASE_URL = the table owner, APP_DB_ROLE = the apps' role):
//
//   APP_DATABASE_URL_ADMIN=... APP_DATABASE_URL_WEB=... docker run --rm --env-file env/migrator.env \
//     -e APP_DATABASE_URL_ADMIN -e APP_DATABASE_URL_WEB <migrator image> node_modules/.bin/tsx src/ops/check-app-role.ts
//
// Two halves: (1) as the owner, the role itself (appRoleProblems: no TRUNCATE, owns nothing, no
// memberships, plain DML on every table); (2) for each APP_DATABASE_URL_* given (admin's and web's
// own DATABASE_URL, copied from their env files by the deploy script), that a real login with it
// is the app role (current_user, so a provider's username suffix does not matter), so "the role
// is fine but the apps still connect as the owner" cannot pass. Prints one line per problem and exits 1 when any exist (the deploy then stops
// before any app container is touched); exits 2 when it cannot run. Never prints a connection string
// or a password.

const url = process.env.DATABASE_URL;
const appRole = process.env.APP_DB_ROLE?.trim() ?? "";
if (!url || appRole === "") {
  console.error("check-app-role: DATABASE_URL (the table owner) and APP_DB_ROLE must be set");
  process.exit(2);
}
try {
  assertRoleName(appRole);
} catch (error) {
  console.error(`check-app-role: ${(error as Error).message}`);
  process.exit(2);
}

const appUrls = (["ADMIN", "WEB"] as const)
  .map((app) => ({ app: app.toLowerCase(), url: process.env[`APP_DATABASE_URL_${app}`]?.trim() ?? "" }))
  .filter((entry) => entry.url !== "");

const sql = postgres(url, { max: 1, onnotice: () => {} });
let exitCode = 0;
try {
  const problems = await appRoleProblems(sql, appRole);
  for (const { app, url: appUrl } of appUrls) problems.push(...(await appConnectionProblems(appUrl, appRole, `${app}.env DATABASE_URL`)));
  if (problems.length === 0) {
    const apps = appUrls.length > 0 ? `; ${appUrls.map((entry) => entry.app).join(" and ")} log in as it` : "";
    console.log(`check-app-role: PASS ${appRole} cannot TRUNCATE, owns nothing, and has plain DML on every table${apps}`);
  } else {
    for (const problem of problems) console.error(`check-app-role: FAIL ${problem}`);
    exitCode = 1;
  }
} catch (error) {
  console.error(`check-app-role: could not run: ${(error as Error).message}`);
  exitCode = 2;
} finally {
  await sql.end();
}
process.exit(exitCode);

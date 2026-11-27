import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import postgres from "postgres";

// The application's own database role (docs/plans/accounting.md §8.1 Session 12, runbook R1).
//
// Row-level triggers never fire on TRUNCATE, so `TRUNCATE journal_lines` (or `journal_entries
// CASCADE`) would bypass every append-only guard of the ledger and of the other append-only tables.
// Decided (26 Nov 2026): no TRUNCATE triggers; instead the apps connect as a role that cannot
// TRUNCATE at all. A table's OWNER (and a superuser) always can, and can also disable triggers, so
// the apps must not connect as the owner. Until Session 12 they did: admin, web and the migrator all
// used one DATABASE_URL (on prod the Postgres container's superuser). The split:
//
//   - the OWNER role (today's DATABASE_URL user) keeps owning every table; only the migrator (and
//     the backup, which uses the db container's own superuser) connects as it, via env/migrator.env;
//   - the APP role (e.g. `ammari_app`, LOGIN, no superuser/createdb/createrole, never a member of the
//     owner) gets SELECT, INSERT, UPDATE, DELETE on every table in `public`, nothing else (no
//     TRUNCATE, no TRIGGER, no REFERENCES), plus default privileges so every table a later migration
//     creates gets the same grants. admin.env and web.env connect as it.
//
// setupAppRole() does the grants (idempotent; run by hand through the migrator image,
// src/ops/setup-app-role.ts). appRoleProblems() is the verification the deploy pipeline runs after
// every migration (src/ops/check-app-role.ts): it fails loudly when the app role can TRUNCATE any
// table, owns one, is a superuser or a member of the owner, or lacks plain DML on a table (which a
// migration created by someone other than the owner would cause, breaking the app).

type Sql = postgres.Sql | postgres.TransactionSql;

function postgresClient(url: string): postgres.Sql {
  return postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
}


/** The ledger and append-only tables the plan names (§8.1 Session 12), re-checked against the
 * schema on 27 Nov 2026 (Session 11's fixed asset tables, Session 6's order_manual_payments and
 * the payment/settlement records added). The check covers EVERY table in `public`; this list must
 * additionally exist, so a rename shows up here instead of silently dropping out of the check. */
export const PROTECTED_TABLES = [
  "accounts",
  "account_mappings",
  "fiscal_periods",
  "journal_entries",
  "journal_lines",
  "posting_runs",
  "posting_issues",
  "tax_settings",
  "fixed_asset_groups",
  "fixed_asset_settings",
  "fixed_assets",
  "order_manual_payments",
  "stock_movements",
  "fabric_stock_movements",
  "accessory_movements",
  "defect_movements",
  "goods_receipts",
  "goods_receipt_items",
  "supplier_payments",
  "purchase_attachments",
  "private_files",
  "business_expenses",
  "audit_log",
  "payments",
  "payment_notifications",
  "order_channel_fees",
  "order_settlements",
] as const;

/** Privileges the app role must never hold on any table. */
export const FORBIDDEN_TABLE_PRIVILEGES = ["TRUNCATE", "TRIGGER", "REFERENCES"] as const;
/** Privileges the app role must hold on every table in `public`. */
export const REQUIRED_TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

const ROLE_NAME = /^[a-z_][a-z0-9_]{2,62}$/;
/** Generated with `openssl rand -hex 32`; letters and digits only, so it is safe in a URL and in
 * the quoted literal below. */
const PASSWORD = /^[A-Za-z0-9]{32,128}$/;

/** The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802/7677, in Postgres's format
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`). CREATE/ALTER ROLE ... PASSWORD with
 * a verifier stores it as is. The password is letters and digits only (PASSWORD), for which SASLprep
 * is the identity, so the login with the plaintext matches. */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function assertRoleName(name: string): void {
  if (!ROLE_NAME.test(name)) throw new Error(`APP_DB_ROLE must match ${ROLE_NAME} (got ${JSON.stringify(name)})`);
}

export function assertPassword(password: string): void {
  if (!PASSWORD.test(password)) throw new Error("APP_DB_PASSWORD must be 32-128 letters and digits (use `openssl rand -hex 32`)");
}

/** Every problem with `appRole`, as one line each; empty when the role is as it must be. Run as the
 * owner role (the migrator's DATABASE_URL), which can read every privilege. */
export async function appRoleProblems(sql: Sql, appRole: string): Promise<string[]> {
  assertRoleName(appRole);
  const problems: string[] = [];
  const [role] = await sql<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]>`
    select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin from pg_roles where rolname = ${appRole}`;
  if (!role) return [`role ${appRole} does not exist`];
  const [me] = await sql<{ name: string }[]>`select current_user as name`;
  if (me!.name === appRole) problems.push(`the check runs as ${appRole} itself; run it as the table owner (env/migrator.env)`);
  if (role.rolsuper) problems.push(`${appRole} is a superuser (bypasses every privilege)`);
  if (role.rolcreaterole) problems.push(`${appRole} has CREATEROLE`);
  if (role.rolcreatedb) problems.push(`${appRole} has CREATEDB`);
  if (role.rolbypassrls) problems.push(`${appRole} has BYPASSRLS`);
  if (!role.rolcanlogin) problems.push(`${appRole} cannot log in`);

  // Ownership gives TRUNCATE and DISABLE TRIGGER for good. Membership in ANY role is refused: the
  // role is NOINHERIT, so has_table_privilege below would not see what another role holds, yet SET
  // ROLE would reach it (the table owner's rights, a role granted TRUNCATE, pg_write_all_data, ...).
  const [owns] = await sql<{ count: number }[]>`
    select count(*)::int as count from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and pg_get_userbyid(c.relowner) = ${appRole}`;
  if (owns!.count > 0) problems.push(`${appRole} owns objects in public (an owner can always TRUNCATE and disable triggers)`);
  const memberships = await sql<{ name: string }[]>`
    select pg_get_userbyid(m.roleid) as name from pg_auth_members m
    where m.member = (select oid from pg_roles where rolname = ${appRole}) order by 1`;
  for (const { name } of memberships) problems.push(`${appRole} is a member of ${name} (SET ROLE would reach its rights)`);

  // Tables need plain DML; views, materialized views and foreign tables (which `grant ... on all
  // tables` also covers) are checked for the forbidden privileges only.
  const tables = await sql<{ name: string; kind: string; forbidden: string[] | null; missing: string[] | null }[]>`
    select c.relname as name, c.relkind::text as kind,
      array(select p from unnest(${sql.array([...FORBIDDEN_TABLE_PRIVILEGES])}::text[]) p where has_table_privilege(${appRole}, c.oid, p)) as forbidden,
      array(select p from unnest(${sql.array([...REQUIRED_TABLE_PRIVILEGES])}::text[]) p where not has_table_privilege(${appRole}, c.oid, p)) as missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by c.relname`;
  const present = new Set(tables.filter((table) => table.kind === "r" || table.kind === "p").map((table) => table.name));
  for (const name of PROTECTED_TABLES) if (!present.has(name)) problems.push(`protected table ${name} is missing from public (update PROTECTED_TABLES)`);
  for (const table of tables) {
    if (table.forbidden && table.forbidden.length > 0) problems.push(`${appRole} has ${table.forbidden.join(", ")} on ${table.name}`);
    const isTable = table.kind === "r" || table.kind === "p";
    if (isTable && table.missing && table.missing.length > 0) problems.push(`${appRole} lacks ${table.missing.join(", ")} on ${table.name} (the app would fail on it)`);
  }

  const [schema] = await sql<{ usage: boolean; create: boolean }[]>`
    select has_schema_privilege(${appRole}, 'public', 'USAGE') as usage, has_schema_privilege(${appRole}, 'public', 'CREATE') as create`;
  if (!schema!.usage) problems.push(`${appRole} lacks USAGE on schema public`);
  if (schema!.create) problems.push(`${appRole} has CREATE on schema public (it could create objects it then owns)`);
  return problems;
}

/** Problems with one app's own connection string (admin's or web's DATABASE_URL): a real login
 * with it must be `appRole` (current_user, so a provider's username suffix does not matter) and
 * must not be able to TRUNCATE. `label` names it in the messages; the URL itself is never printed. */
export async function appConnectionProblems(appUrl: string, appRole: string, label: string): Promise<string[]> {
  let client: postgres.Sql | null = null;
  try {
    client = postgresClient(appUrl);
    const [row] = await client<{ user: string; truncate: boolean }[]>`
      select current_user as user, has_table_privilege(current_user, 'public.journal_lines', 'TRUNCATE') as truncate`;
    if (row!.user !== appRole) return [`${label} does not log in as ${appRole} (the app still connects as another role)`];
    if (row!.truncate) return [`${label} can TRUNCATE journal_lines`];
    return [];
  } catch (error) {
    return [`${label} cannot log in as ${appRole}: ${(error as Error).message}`];
  } finally {
    await client?.end();
  }
}

/** Creates (or updates) the app role and its grants. Idempotent. Run as the table owner. A given
 * password is set (on create, or to rotate it); without one an existing role keeps its password and
 * a new role is refused (it could never log in). */
export async function setupAppRole(sql: postgres.Sql, appRole: string, password: string | null): Promise<string[]> {
  assertRoleName(appRole);
  if (password !== null) assertPassword(password);
  const done: string[] = [];
  await sql.begin(async (tx) => {
    const [me] = await tx<{ name: string; db: string }[]>`select current_user as name, current_database() as db`;
    if (me!.name === appRole) throw new Error(`run this as the table owner, not as ${appRole}`);
    const [existing] = await tx`select 1 from pg_roles where rolname = ${appRole}`;
    // DDL takes no bind parameters: the role name matches ROLE_NAME, the owner, database and member
    // role names are quoted with quoteIdent, and only the SCRAM verifier of the password is sent
    // (base64, `$`, `:` and digits: no quote can occur in it; the plaintext never reaches the
    // server, so a server log of DDL cannot capture it).
    const role = quoteIdent(appRole);
    const owner = quoteIdent(me!.name);
    const run = (statement: string) => tx.unsafe(statement);
    const attributes = "login nosuperuser nocreatedb nocreaterole noinherit nobypassrls";
    if (!existing) {
      if (password === null) throw new Error(`role ${appRole} does not exist yet: set APP_DB_PASSWORD to create it`);
      await run(`create role ${role} ${attributes} password '${scramSha256Verifier(password)}'`);
      done.push(`created role ${appRole}`);
    } else {
      await run(`alter role ${role} ${attributes}`);
      if (password !== null) {
        await run(`alter role ${role} password '${scramSha256Verifier(password)}'`);
        done.push(`set a new password for ${appRole}`);
      }
    }
    // No membership in any role (appRoleProblems refuses every one).
    const memberships = await tx<{ name: string }[]>`
      select pg_get_userbyid(m.roleid) as name from pg_auth_members m where m.member = (select oid from pg_roles where rolname = ${appRole})`;
    for (const { name } of memberships) {
      await run(`revoke ${quoteIdent(name)} from ${role}`);
      done.push(`removed ${appRole} from role ${name}`);
    }
    await run(`grant connect on database ${quoteIdent(me!.db)} to ${role}`);
    await run(`grant usage on schema public to ${role}`);
    await run(`revoke create on schema public from ${role}`);
    await run(`revoke all on all tables in schema public from ${role}`);
    await run(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await run(`revoke all on all sequences in schema public from ${role}`);
    await run(`grant usage, select on all sequences in schema public to ${role}`);
    // Tables and sequences a later migration creates (as the owner) get the same grants.
    await run(`alter default privileges for role ${owner} in schema public revoke all on tables from ${role}`);
    await run(`alter default privileges for role ${owner} in schema public grant select, insert, update, delete on tables to ${role}`);
    await run(`alter default privileges for role ${owner} in schema public grant usage, select on sequences to ${role}`);
    done.push(`granted ${appRole} SELECT, INSERT, UPDATE, DELETE on every table in public (no TRUNCATE, TRIGGER, REFERENCES), and the same for tables ${me!.name} creates later`);
  });
  return done;
}

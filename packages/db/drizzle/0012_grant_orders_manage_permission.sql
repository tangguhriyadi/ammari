-- Hand-authored, no schema.ts diff (same category as 0001_rbac_triggers.sql) — `drizzle-kit
-- generate` has nothing to emit here since no table/column changes, only data.
--
-- Why this exists: migration 0011 added the "orders.manage" permission key to
-- packages/db/src/rbac/permissions.ts, but packages/db/src/seed.ts (which syncs PERMISSIONS
-- into the `permissions` table and grants super_admin/owner their default permission sets) has
-- no automatic trigger anywhere — dev/prod have no CI/deploy step that runs it today, so a new
-- permission key added to code is otherwise invisible to every already-provisioned role until
-- someone remembers to run `pnpm --filter @ammari/db db:seed` by hand against that exact
-- database. That gap is exactly how "orders.manage" ended up missing from a real local dev
-- database after this feature shipped: super_admin and owner are SUPPOSED to get every
-- business permission automatically (docs/SPEC.md §9's "super_admin: every permission" /
-- "owner: all business permissions"), but that's an app-code convention
-- (superAdminDefaultPermissionKeys/ownerDefaultPermissionKeys), not a DB-enforced guarantee —
-- nothing re-runs it when the permission catalog grows.
--
-- Migrations DO run reliably on every environment (docs/SPEC.md §2.3: "Database migrations run
-- as a separate step before the new containers start"), unlike the seed script — so going
-- forward, any new permission key added to PERMISSIONS must ship with a migration exactly like
-- this one (idempotent INSERT ... ON CONFLICT DO NOTHING), not rely on db:seed alone. See the
-- doc comment on PERMISSIONS in packages/db/src/rbac/permissions.ts for this same note.
--
-- Idempotent and safe to run against a database that already has this permission/grant (a
-- fresh db:seed run, or a database this already landed on) — ON CONFLICT DO NOTHING on both
-- inserts.
INSERT INTO "permissions" ("key", "description", "group")
VALUES ('orders.manage', 'Record manual orders and change order status', 'orders')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'owner') AND p."key" = 'orders.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

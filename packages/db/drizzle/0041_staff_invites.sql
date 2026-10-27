ALTER TABLE "staff_users" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "invite_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "invited_by_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_invited_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("invited_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_invite_expiry_check" CHECK ("staff_users"."invite_expires_at" is null or "staff_users"."invited_at" is not null);--> statement-breakpoint

-- ============================================================================================
-- Hand-authored below this line (same idiom as migrations 0008/0024/0037/0038): drizzle-kit does
-- not emit reference data, permission grants or triggers. docs/plans/roles-staff.md §3.
--
-- Backward compatibility with the release currently on prod: everything above only adds nullable
-- columns, a self-FK and a CHECK every existing row passes (both new timestamps are NULL). The
-- previous release never reads or writes them, and never UPDATEs staff_users.is_active/role_id
-- (it has no staff UI), so the trigger below can't fire for it. Rolling back the image leaves an
-- unexpired-invite check unenforced for that release only (it admits any active row, as today).
-- ============================================================================================

-- 1. Owner answer 2: the owner role manages staff (staff.manage), within the subset rule enforced
--    in apps/admin lib/staff. OWNER_EXCLUDED_PERMISSION_KEYS no longer lists it. Idempotent.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" = 'owner' AND p."key" = 'staff.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

-- Only rewrites the description if nobody has changed it from the seeded text.
UPDATE "roles"
SET "description" = 'All business permissions and staff.manage; not roles.manage or audit_log.view by default.'
WHERE "key" = 'owner'
  AND "description" = 'All business permissions; not roles.manage, staff.manage, or audit_log.view by default.';--> statement-breakpoint

-- 2. Predefined roles (PREDEFINED_ROLES in packages/db/src/rbac/permissions.ts; keep in sync by
--    hand, migration-0041.test.ts compares them). Each role and its grants are inserted only if
--    the role key does not exist yet: the CTE's RETURNING is empty on conflict, so a role an admin
--    has already edited is never re-granted. is_system = false: editable by super_admin.
WITH new_role AS (
  INSERT INTO "roles" ("key", "name", "description", "is_system")
  VALUES ('packing_warehouse', 'Packing/Gudang', 'Antrean packing, cetak kartu dan stiker, tandai dikirim, lihat stok, terima barang datang.', false)
  ON CONFLICT ("key") DO NOTHING
  RETURNING "id"
)
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT new_role."id", p."id"
FROM new_role, "permissions" p
WHERE p."key" IN ('orders.view', 'orders.manage', 'packing.print_cards', 'stock.view', 'inventory.view', 'inventory.receive')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

WITH new_role AS (
  INSERT INTO "roles" ("key", "name", "description", "is_system")
  VALUES ('content_admin', 'Admin Konten', 'Konten toko online: beranda, halaman info, tabel ukuran, deskripsi produk.', false)
  ON CONFLICT ("key") DO NOTHING
  RETURNING "id"
)
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT new_role."id", p."id"
FROM new_role, "permissions" p
WHERE p."key" IN ('content.manage', 'stock.view')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

WITH new_role AS (
  INSERT INTO "roles" ("key", "name", "description", "is_system")
  VALUES ('customer_service', 'CS/Pesanan', 'Pesanan WhatsApp/Instagram/offline, status pesanan, data pelanggan, cek stok.', false)
  ON CONFLICT ("key") DO NOTHING
  RETURNING "id"
)
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT new_role."id", p."id"
FROM new_role, "permissions" p
WHERE p."key" IN ('overview.view', 'orders.view', 'orders.manage', 'customers.view', 'stock.view')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

WITH new_role AS (
  INSERT INTO "roles" ("key", "name", "description", "is_system")
  VALUES ('finance', 'Keuangan', 'Laba, biaya, pembayaran supplier, impor marketplace. Tidak mengubah produk atau stok.', false)
  ON CONFLICT ("key") DO NOTHING
  RETURNING "id"
)
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT new_role."id", p."id"
FROM new_role, "permissions" p
WHERE p."key" IN ('overview.view', 'orders.view', 'orders.import', 'inventory.view', 'ads_expenses.manage', 'finance.view_profit', 'supplier_payments.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

-- 3. Backstop: the last super_admin who can log in can never be deactivated, moved to another
--    role, or deleted. apps/admin checks this first (with an Indonesian message); this trigger is
--    what holds if that check is ever bypassed or raced, including a manual DELETE.
--    - DEFERRABLE INITIALLY DEFERRED: it judges the state at COMMIT (a transaction may demote one
--      super_admin and promote another).
--    - It takes the same advisory lock as every app-side staff write (STAFF_ACCESS_LOCK_KEY,
--      'ammari.staff_access') before counting. Under READ COMMITTED the count then runs on a
--      fresh snapshot, so two concurrent transactions each removing a different super_admin
--      can't both pass (write skew; migration-0041.test.ts runs exactly that).
--    - That fresh snapshot only exists under READ COMMITTED (the app's and Postgres's default).
--      Under REPEATABLE READ/SERIALIZABLE the snapshot is fixed at transaction start, so removing
--      a super_admin there is refused outright (fail closed) rather than judged on a stale count.
--      (Locking the other super_admin rows FOR UPDATE instead was tried: two overlapping
--      removals then deadlock on each other's row lock.)
--    - "Can log in" = active, and either logged in before or a row with no invite expiry (seed
--      accounts). A pending invitation doesn't count: the person may never accept it. Same rule
--      as apps/admin's assertNotLastProtectedHolder.
--    - Fires only when the OLD row was such a super_admin, so a database with none, ordinary
--      updates (last_login_at, name) and TRUNCATE are unaffected.
--    The last-owner rule is app-only: losing the last owner is recoverable by a super_admin.
CREATE OR REPLACE FUNCTION prevent_last_super_admin_loss() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  super_admin_role_id uuid;
BEGIN
  SELECT "id" INTO super_admin_role_id FROM "roles" WHERE "key" = 'super_admin';
  IF super_admin_role_id IS NULL
    OR NOT (OLD."is_active" AND OLD."role_id" = super_admin_role_id
            AND (OLD."last_login_at" IS NOT NULL OR OLD."invite_expires_at" IS NULL)) THEN
    RETURN NULL;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'removing a super_admin requires READ COMMITTED isolation'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ammari.staff_access'));
  IF NOT EXISTS (
    SELECT 1 FROM "staff_users"
    WHERE "is_active" AND "role_id" = super_admin_role_id
      AND ("last_login_at" IS NOT NULL OR "invite_expires_at" IS NULL)
  ) THEN
    RAISE EXCEPTION 'cannot deactivate, demote or delete the last active super_admin'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER prevent_last_super_admin_loss
AFTER UPDATE OF "is_active", "role_id" OR DELETE ON "staff_users"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION prevent_last_super_admin_loss();

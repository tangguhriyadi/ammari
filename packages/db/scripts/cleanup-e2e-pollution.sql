-- One-off cleanup: removes e2e-test fixtures that leaked into the real local `ammari` database
-- before e2e was pointed at its own isolated `ammari_e2e` database (see apps/admin/e2e/
-- global-setup.ts and apps/admin/playwright.config.ts). NOT run automatically — the owner
-- reviewed the exact matched rows first. Run by hand, against `ammari` ONLY, e.g.:
--   docker compose exec -T db psql -U ammari -d ammari -f packages/db/scripts/cleanup-e2e-pollution.sql
--
-- Matches by the same naming patterns e2e fixtures always use:
--   products:    name ILIKE '%e2e%'                 (e.g. "Contoh Gamis Foto E2E ...", "E2E Pagination Produk ...")
--   fabrics:     name ILIKE 'e2e%'                   (e.g. "E2E Bahan ...", "E2E Pagination Fabric")
--   staff_users: email LIKE '%e2e.ammari.test'       (the e2e sign-in backdoor's fixed email suffix)
--   roles:       key ILIKE 'e2e%'                    (e.g. "e2e_products_no_finance")
--
-- Order matters — see the FK delete_rule audit this script was built from (mostly RESTRICT, not
-- CASCADE, in this schema): dependents are removed before the rows they reference.

begin;

-- 1. Staff auth sessions/accounts for the e2e staff fixtures.
delete from staff_auth_sessions
where user_id in (
  select sau.id from staff_auth_users sau
  join staff_users su on su.id = sau.staff_user_id
  where su.email like '%e2e.ammari.test'
);

delete from staff_auth_accounts
where user_id in (
  select sau.id from staff_auth_users sau
  join staff_users su on su.id = sau.staff_user_id
  where su.email like '%e2e.ammari.test'
);

-- 2. Audit log rows attributed to the e2e staff fixtures (audit_log.actor_staff_user_id is
-- RESTRICT, so staff_users can't be deleted while these remain).
delete from audit_log
where actor_staff_user_id in (select id from staff_users where email like '%e2e.ammari.test');

-- 3. The staff auth identity, then the staff fixture itself, then its email-throttle state.
delete from staff_auth_users
where staff_user_id in (select id from staff_users where email like '%e2e.ammari.test');

delete from auth_email_throttle where email like '%e2e.ammari.test';

delete from staff_users where email like '%e2e.ammari.test';

-- 4. Product variants, then products (product_images cascades with its product).
delete from product_variants
where product_id in (select id from products where name ilike '%e2e%');

delete from products where name ilike '%e2e%';

-- 5. Any leftover variants still pointing at an e2e fabric (defensive — covers a variant whose
-- product name didn't happen to match the pattern above), then fabric colors, then fabrics.
delete from product_variants
where fabric_id in (select id from fabrics where name ilike 'e2e%');

delete from fabric_colors
where fabric_id in (select id from fabrics where name ilike 'e2e%');

delete from fabrics where name ilike 'e2e%';

-- 6. The e2e-only limited role (e2e_products_no_finance).
delete from role_permissions
where role_id in (select id from roles where key ilike 'e2e%');

delete from roles where key ilike 'e2e%';

commit;

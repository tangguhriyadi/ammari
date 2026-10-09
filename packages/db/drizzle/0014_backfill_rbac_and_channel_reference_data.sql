-- Hand-authored, no schema.ts diff — closes a gap the owner found: /orders/new was still
-- missing the whatsapp/instagram/offline channels after migration 0011 extended
-- channels_id_check to allow them, because nothing ever actually INSERTs channel rows except
-- packages/db/src/seed.ts's upsertChannels(), and nothing re-runs that against a real database
-- when CHANNEL_IDS grows (migration 0012's own doc comment already flagged this exact class of
-- bug for permissions specifically; it turns out channels, roles, and the rest of the permission
-- catalog had the same gap, just not yet noticed).
--
-- Audited packages/db/src/seed.ts in full: everything below (channels, the full permission
-- catalog, the two system roles and their default grants) is reference data application code
-- treats as a closed, hardcoded set (CHANNEL_IDS, PERMISSIONS, SUPER_ADMIN_ROLE_KEY/
-- OWNER_ROLE_KEY) — exactly what CLAUDE.md's new rule means by "reference data the code depends
-- on." seed.ts's other three functions are deliberately left alone: seedInitialCostAssumptions
-- and seedCostComponentDefaults seed an editable starting value / master-data row, not a closed
-- set the code matches against by literal key, and seedStaffUsers reads deploy-specific email
-- addresses from environment variables — neither belongs in a migration.
--
-- Fully idempotent (ON CONFLICT DO NOTHING throughout) — safe to run against a database any of
-- this already landed on via a prior `db:seed` run, including this exact row set.

INSERT INTO "channels" ("id", "name") VALUES
  ('shopee', 'Shopee'),
  ('tiktok', 'TikTok Shop'),
  ('web', 'Main site'),
  ('reseller', 'Reseller'),
  ('whatsapp', 'WhatsApp'),
  ('instagram', 'Instagram'),
  ('offline', 'Offline')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

INSERT INTO "permissions" ("key", "group", "description") VALUES
  ('overview.view', 'overview', 'View the overview dashboard'),
  ('orders.view', 'orders', 'View orders'),
  ('orders.manage', 'orders', 'Record manual orders and change order status'),
  ('orders.import', 'orders', 'Import Shopee/TikTok order and income exports'),
  ('packing.print_cards', 'packing', 'Print thank-you cards during packing'),
  ('stock.view', 'stock', 'View stock levels and movements'),
  ('stock.adjust', 'stock', 'Record manual stock adjustments'),
  ('production.manage', 'production', 'Manage production batches'),
  ('products.manage', 'products', 'Manage products, variants, and images'),
  ('inventory.view', 'inventory', 'View accessory and fabric stock levels and ledgers'),
  ('inventory.manage', 'inventory', 'Manage accessories, record purchases, void purchases, and adjust raw-material stock'),
  ('ads_expenses.manage', 'ads_expenses', 'Record ad spend and expenses'),
  ('finance.view_profit', 'finance', 'View cost, profit, and payout figures'),
  ('settings.manage', 'settings', 'Manage targets, cost assumptions, and settings'),
  ('customers.view', 'customers', 'View customers'),
  ('vouchers.void', 'vouchers', 'Void a voucher'),
  ('staff.manage', 'staff', 'Manage staff accounts'),
  ('roles.manage', 'roles', 'Manage roles and role permissions'),
  ('audit_log.view', 'audit_log', 'View the audit log')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "roles" ("key", "name", "description", "is_system") VALUES
  ('super_admin', 'Super Admin', 'Every permission, including roles.manage, staff.manage, audit_log.view, and risky actions.', true),
  ('owner', 'Owner', 'All business permissions; not roles.manage, staff.manage, or audit_log.view by default.', true)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- super_admin: every permission (docs/SPEC.md §9).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

-- owner: every permission EXCEPT roles.manage/staff.manage/audit_log.view (docs/SPEC.md §9,
-- packages/db/src/rbac/permissions.ts's OWNER_EXCLUDED_PERMISSION_KEYS).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" = 'owner' AND p."key" NOT IN ('roles.manage', 'staff.manage', 'audit_log.view')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

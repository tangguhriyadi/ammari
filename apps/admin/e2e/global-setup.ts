import { existsSync } from "node:fs";
import { startStorefrontStub } from "./helpers/storefront-stub";

// Fixed, e2e-only addresses — the sign-in backdoor (app/api/test/login/route.ts) refuses any
// email outside this suffix, so these fixtures can never double as real staff credentials.
export const E2E_SUPER_ADMIN_EMAIL = "super-admin@e2e.ammari.test";
export const E2E_OWNER_EMAIL = "owner@e2e.ammari.test";
// A non-system role with products.manage but NOT finance.view_profit — owner and super_admin
// both hold finance.view_profit by default (docs/SPEC.md §9), so neither can exercise the Batas
// HPP gating test; this fixture exists specifically for that.
export const E2E_PRODUCTS_NO_FINANCE_EMAIL = "products-no-finance@e2e.ammari.test";
const E2E_LIMITED_ROLE_KEY = "e2e_products_no_finance";
// A dedicated role/email for the production+stock e2e flow — owner and super_admin are already
// used right up to the 5-per-5-minutes OTP send throttle across the rest of this suite (see the
// per-test comments explaining that budget), so a 6th login on either tips it over. A fresh
// email starts with its own clean throttle window regardless of how loaded the other two are.
export const E2E_PRODUCTION_STOCK_EMAIL = "production-stock@e2e.ammari.test";
const E2E_PRODUCTION_STOCK_ROLE_KEY = "e2e_production_stock";
// A dedicated role/email for the orders e2e flow (manual entry + stock decrement/restore) — same
// "fresh email, clean OTP throttle" reasoning as E2E_PRODUCTION_STOCK_EMAIL above. Needs
// products.manage/production.manage/stock.* too, since the flow seeds its own finished-goods
// stock via a real production batch before placing an order against it.
export const E2E_ORDERS_EMAIL = "orders@e2e.ammari.test";
const E2E_ORDERS_ROLE_KEY = "e2e_orders";
// A dedicated role/email for the packing e2e flow (print cards + mark shipped + cancel-voids-
// card) — same "fresh email, clean OTP throttle" reasoning as every other dedicated fixture
// above; also needs packing.print_cards on top of everything E2E_ORDERS_EMAIL already has,
// since this flow seeds its own finished-goods stock via a real production batch too.
export const E2E_PACKING_EMAIL = "packing@e2e.ammari.test";
const E2E_PACKING_ROLE_KEY = "e2e_packing";
// A second email on the SAME `e2e_packing` role, dedicated to packing-print.spec.ts — that spec
// logs in up to 4 times in one run (2 layouts × chromium + webkit), which on top of
// packing.spec.ts's own login against E2E_PACKING_EMAIL tips over the 5-per-5-minutes OTP send
// throttle if both specs share one email. Same role, no new permissions to maintain.
export const E2E_PACKING_PRINT_EMAIL = "packing-print@e2e.ammari.test";
// A THIRD email, same role again, used only by packing-print.spec.ts's WebKit runs — WebKit's
// `retries: 2` (playwright.config.ts, absorbing a known flaky `next dev` HMR/Fast-Refresh race;
// see docs/plans/packing-cards.md) means each of its 2 tests can log in up to 3 times, which on
// top of Chromium's own 2 logins against E2E_PACKING_PRINT_EMAIL in the SAME full-suite run would
// otherwise tip over the shared throttle. Separate email, separate budget.
export const E2E_PACKING_PRINT_WEBKIT_EMAIL = "packing-print-webkit@e2e.ammari.test";
// A FOURTH email, same role again, for packing-stickers.spec.ts (docs/plans/thermal-stickers.md)
// — same "fresh email, clean OTP throttle" reasoning as every dedicated fixture above; this spec
// logs in at both a mobile and a desktop viewport in the same run.
export const E2E_PACKING_STICKERS_EMAIL = "packing-stickers@e2e.ammari.test";
// A dedicated email for product-highlights.spec.ts (docs/plans/product-highlights.md) — same
// "fresh email, clean OTP throttle" reasoning as every dedicated fixture above; this spec logs
// in once but runs its edit/reorder flow at both a mobile and a desktop viewport in the same
// run. Owner role (products.manage), same as products.spec.ts's own E2E_OWNER_EMAIL.
export const E2E_PRODUCT_HIGHLIGHTS_EMAIL = "product-highlights@e2e.ammari.test";
// A dedicated email for storefront-section.spec.ts (docs/plans/storefront-cms.md) — same "fresh
// email, clean OTP throttle" reasoning as every dedicated fixture above; this spec logs in once
// but runs a full create-fabric/product/photo/size-chart/publish flow at both a mobile and a
// desktop viewport in the same run, plus visits /content/size-charts. Owner role (products.manage
// AND content.manage — owner gets every permission except OWNER_EXCLUDED_PERMISSION_KEYS, and
// content.manage isn't in that list), same as E2E_PRODUCT_HIGHLIGHTS_EMAIL.
export const E2E_STOREFRONT_EMAIL = "storefront@e2e.ammari.test";
// A dedicated email for variant-photos.spec.ts (active-by-default variants, "Belum ada foto"
// reminders, default photo alt text, the publish-needs-a-photo guard) — same "fresh email, clean
// OTP throttle" reasoning as every dedicated fixture above. Owner role: the flow spans
// products.manage, production.manage and content.manage.
export const E2E_VARIANT_PHOTOS_EMAIL = "variant-photos@e2e.ammari.test";
// A dedicated email/role for suppliers.spec.ts (docs/plans/suppliers-goods-receipt.md, session
// 1) — same "fresh email, clean OTP throttle" reasoning as every dedicated fixture above (the
// sign-in backdoor sends a real OTP, so each loginAs spends one of the 5-per-5-minutes budget).
// The role holds EXACTLY inventory.view + inventory.manage, which doubles as a regression guard:
// the whole supplier master must work on those two keys alone, with no new permission (D10/§7).
export const E2E_SUPPLIERS_EMAIL = "suppliers@e2e.ammari.test";
// A dedicated email for fresh-after-save.spec.ts (lists and detail pages show a save without a
// reload) — same "fresh email, clean OTP throttle" reasoning as every fixture above. Owner role:
// the flow spans products, fabrics, accessories and suppliers.
export const E2E_FRESH_AFTER_SAVE_EMAIL = "fresh-after-save@e2e.ammari.test";
const E2E_SUPPLIERS_ROLE_KEY = "e2e_suppliers";
// Dedicated emails for purchase-payments.spec.ts (docs/plans/purchase-payments.md session S3),
// same "fresh email, clean OTP throttle" reasoning as every fixture above. The owner role holds
// supplier_payments.manage (granted by migration 0038) plus everything the flow needs to build its
// own fabric and purchase. The second email sits on the existing `e2e_suppliers` role
// (inventory.view + inventory.manage, NO finance.view_profit): it must see the payment badge but
// never an amount, a proof, or "Catat pembayaran" (A8).
export const E2E_SUPPLIER_PAYMENTS_EMAIL = "supplier-payments@e2e.ammari.test";
export const E2E_PAYMENTS_NO_FINANCE_EMAIL = "payments-no-finance@e2e.ammari.test";
// Dedicated emails for production-payments.spec.ts (session S4), same "fresh email, clean OTP
// throttle" reasoning. The owner role builds its own fabric, product, suppliers and batch and
// holds supplier_payments.manage. The second email sits on a role with EXACTLY production.manage
// (no finance.view_profit): it must see the batch's payment badge but never an amount, a proof,
// or "Catat pembayaran" (A8).
export const E2E_PRODUCTION_PAYMENTS_EMAIL = "production-payments@e2e.ammari.test";
export const E2E_PRODUCTION_PAYMENTS_NO_FINANCE_EMAIL = "production-payments-no-finance@e2e.ammari.test";
const E2E_PRODUCTION_NO_FINANCE_ROLE_KEY = "e2e_production_no_finance";
// A dedicated email/role for purchases-receipt.spec.ts (docs/plans/suppliers-goods-receipt.md
// session S3) — same "fresh email, clean OTP throttle" reasoning as every fixture above. Needs
// products.manage only to create its own fabric fixture; finance.view_profit so the line totals
// are visible; inventory.receive to post receipts.
export const E2E_PURCHASES_EMAIL = "purchases@e2e.ammari.test";
const E2E_PURCHASES_ROLE_KEY = "e2e_purchases";
// A second email on the SAME `e2e_purchases` role, for receipts.spec.ts (session S7: the
// all-receipts list /receipts) — its own OTP throttle, no new permissions to maintain. The role
// has no production.manage, which receipts.spec.ts relies on to assert inventory.view alone
// opens the page.
export const E2E_RECEIPTS_EMAIL = "receipts@e2e.ammari.test";
// A dedicated email/role for defects.spec.ts (docs/plans/suppliers-goods-receipt.md session S5:
// rejects at receipt + defect visibility) — same "fresh email, clean OTP throttle" reasoning as
// every fixture above. Builds its own product, batch and purchase, so it needs everything the
// production+stock fixture has.
export const E2E_DEFECTS_EMAIL = "defects@e2e.ammari.test";
const E2E_DEFECTS_ROLE_KEY = "e2e_defects";
// A second email on the SAME `e2e_defects` role, for defect-dispositions.spec.ts (session S6:
// returns, re-open, releases, variance) — its own OTP throttle, no new permissions to maintain.
export const E2E_DISPOSITIONS_EMAIL = "dispositions@e2e.ammari.test";
// Dedicated emails for login-otp.spec.ts — it drives the REAL `/login` OTP form (not the
// instant-sign-in backdoor every other spec uses), which legitimately sends real OTPs and is the
// one spec that actually exercises the per-email 60s resend cooldown. TWO emails, not one: the
// same "wrong email -> Ganti email -> correct email" flow runs once at a mobile viewport and
// once at desktop in the same suite run, each sending to the "correct" email — sharing one email
// between them would have the desktop run's send land inside the mobile run's own 60s cooldown
// window and get silently suppressed. Owner role — this spec only needs to reach the dashboard
// after signing in, nothing permission-specific.
export const E2E_LOGIN_OTP_EMAIL = "login-otp@e2e.ammari.test";
export const E2E_LOGIN_OTP_MOBILE_EMAIL = "login-otp-mobile@e2e.ammari.test";
// Separate again from the two above: the resend-countdown check and the expired-code check each
// send their own OTP too, and all of these specs can run within 60s of each other in one suite
// run — sharing an email risks one test's send landing inside another's cooldown window.
export const E2E_LOGIN_OTP_RESEND_EMAIL = "login-otp-resend@e2e.ammari.test";
export const E2E_LOGIN_OTP_EXPIRY_EMAIL = "login-otp-expiry@e2e.ammari.test";

// A dedicated email for stock-reservations.spec.ts (docs/plans/cart-checkout.md session 4: the
// read-only "Dipesan" figure), on the existing `e2e_orders` role (stock.view + stock.adjust for the
// count page, orders.view for the order link). Its own OTP throttle, no new permissions.
export const E2E_STOCK_RESERVATIONS_EMAIL = "stock-reservations@e2e.ammari.test";
// The product that spec reads: one SKU held by an unpaid web checkout order, one SKU without a
// hold. Nothing in the admin UI creates a hold (only web checkout does), so it is seeded here.
export const E2E_RESERVATION_PRODUCT_NAME = "E2E Gamis Dipesan";
export const E2E_RESERVATION_HELD_SKU = "E2E-DIPESAN-M";
export const E2E_RESERVATION_FREE_SKU = "E2E-DIPESAN-L";
export const E2E_RESERVATION_ORDER_NO = "ORD-E2E-DIPESAN-0001";

// checkout-orders.spec.ts (docs/plans/cart-checkout.md session 16): web checkout orders in every
// state staff act on, one set per viewport (each test changes its own orders). Only web checkout
// creates them, so they are seeded here; the staffer is on the existing `e2e_packing` role
// (orders.view, orders.manage, packing.print_cards, finance.view_profit).
export const E2E_CHECKOUT_ORDERS_EMAIL = "checkout-orders@e2e.ammari.test";
export const E2E_CHECKOUT_PRODUCT_NAME = "E2E Gamis Web";
export const E2E_CHECKOUT_SKU = "E2E-WEB-M";
export const E2E_CHECKOUT_LAYOUTS = ["390", "1280"] as const;
/** The seeded orders' numbers per viewport: unpaid, paid (Siap Kirim), paid while stock was short,
 * paid and flagged as an anomaly, paid for the resi flow (`ship`), shipped without a resi
 * (`noresi`, as the 2026-10-21 sandbox run left one), and two paid orders for courier booking
 * (Phase K2, courier-booking.spec.ts) with the fake provider: `book` at a normal fake area, `lost` at
 * the area whose booking answer is lost once. */
export function e2eCheckoutOrderNo(kind: "pending" | "paid" | "short" | "flagged" | "ship" | "noresi" | "book" | "lost", layout: (typeof E2E_CHECKOUT_LAYOUTS)[number]): string {
  return `ORD-E2E-WEB-${kind.toUpperCase()}-${layout}`;
}

// The fake shipment provider's areas (packages/commerce/src/shipping/fake.ts): a normal booking, and
// one whose booking answer is lost once (the attempt stays "belum pasti" until "Cek ulang").
const E2E_BOOKING_AREA = "E2EMURAH40111";
const E2E_LOST_ANSWER_AREA = "E2EGANGGUAN40333";

// product-discount.spec.ts (docs/plans/product-discount.md session 2): a dedicated owner email (same
// "fresh email, clean OTP throttle" reasoning as every fixture above) and a product priced at
// Rp350.000 with one variant, so the plan's 350.000 -> 279.000 = "20,2" example works as written
// and the manual-order picker has a SKU to prefill.
export const E2E_PRODUCT_DISCOUNT_EMAIL = "product-discount@e2e.ammari.test";
// product-types.spec.ts (docs/plans/product-types.md): a dedicated owner email, same "fresh email,
// clean OTP throttle" reasoning. Owner holds products.manage, which is all the type master needs.
export const E2E_PRODUCT_TYPES_EMAIL = "product-types@e2e.ammari.test";
// product-stepper.spec.ts (docs/plans/product-stepper.md): a dedicated owner email, same reasoning.
export const E2E_PRODUCT_STEPPER_EMAIL = "product-stepper@e2e.ammari.test";
export const E2E_DISCOUNT_PRODUCT_NAME = "E2E Gamis Diskon";
export const E2E_DISCOUNT_SKU = "E2E-DISKON-M";
/** A web checkout order placed while that product's discount was active (session 4): one line,
 * 2 x Rp279.000 charged, normal Rp350.000 (`order_items.list_unit_price`). The order detail shows
 * the normal price struck next to the paid one. */
export const E2E_DISCOUNT_ORDER_NO = "ORD-E2E-WEB-DISKON";

// A product published before migration 0031 made "Berat kirim" a publish rule (like prod's first
// published product): live, active, no weight. product-shipping-weight.spec.ts reads it; nothing
// in the admin UI can create this state any more, so it is seeded here.
export const E2E_UNWEIGHED_PUBLISHED_PRODUCT_NAME = "E2E Gamis Tanpa Berat";

// overview.spec.ts (docs/plans/dashboard-overview.md sessions 2 to 5): Ringkasan and the "Target
// penjualan" settings. Four dedicated emails, same "fresh email, clean OTP throttle" reasoning as
// every fixture above: an owner for the page, an owner for the settings form (it changes the one
// sales_goal row, so it runs last in that spec), a staff role with overview.view and the modules
// behind "Perlu tindakan" but NOT finance.view_profit (or settings.manage): it must see counts and
// action lists but never a rupiah or the target; and a role with settings.manage but not
// finance.view_profit, which must not see "Target penjualan" on /settings at all.
export const E2E_OVERVIEW_EMAIL = "overview@e2e.ammari.test";
export const E2E_OVERVIEW_SETTINGS_EMAIL = "overview-settings@e2e.ammari.test";
export const E2E_OVERVIEW_NO_FINANCE_EMAIL = "overview-no-finance@e2e.ammari.test";
const E2E_OVERVIEW_NO_FINANCE_ROLE_KEY = "e2e_overview_no_finance";
export const E2E_SETTINGS_NO_FINANCE_EMAIL = "settings-no-finance@e2e.ammari.test";
const E2E_SETTINGS_NO_FINANCE_ROLE_KEY = "e2e_settings_no_finance";
// Manual WhatsApp orders dated yesterday and the day before (Jakarta), so "Kemarin" (the default
// period) has fixed numbers no other spec touches (every other spec's orders are dated today):
// yesterday 2 counted orders, omzet Rp 500.000 (300.000 + 250.000 - 50.000 voucher, ongkir out),
// HPP Rp 120.000 (one line has unit_cost 0: "HPP belum lengkap untuk 1 item"), one cancelled
// order; the day before 1 order, omzet Rp 250.000, HPP Rp 100.000. Plus one Siap Kirim order 5 days
// ago (Rp 300.000), the oldest to_ship order in the database, so "Perlu tindakan" lists it first as
// late (D10).
export const E2E_OVERVIEW_SKU = "E2E-RINGKASAN-M";
export const E2E_OVERVIEW_LATE_ORDER_NO = "ORD-E2E-RINGKASAN-LATE";

// Enough rows to force a second page at the real PAGE_SIZE (20) — see apps/admin's
// lib/products/queries.ts. A distinct name prefix keeps this from colliding with anything a
// test itself creates.
export const E2E_PAGINATION_PRODUCT_PREFIX = "E2E Pagination Produk";
const E2E_PAGINATION_PRODUCT_COUNT = 21;

function assertSafeTarget(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed e2e staff fixtures: NODE_ENV is production.");
  }
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is not set");
  const url = new URL(rawUrl);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const dbName = url.pathname.replace(/^\//, "");
  // Exact name, not just "is local" — e2e fixtures must land in their own database
  // (ammari_e2e), never the owner's real local `ammari` dev database (see CLAUDE.md's "Local
  // environment safety" rule and docs/SPEC.md).
  if (!isLocalHost || dbName !== "ammari_e2e") {
    throw new Error(
      `Refusing to seed e2e staff fixtures: derived target is "${url.hostname}${url.pathname}". ` +
        `e2e only ever runs against host localhost/127.0.0.1, database "ammari_e2e". Check DATABASE_URL.`,
    );
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Loaded here, and @ammari/db imported dynamically below (not statically at module top) —
  // @ammari/db/client.ts reads DATABASE_URL at import time, so a static import would evaluate
  // (and throw) before this line ever ran, since ESM import declarations are hoisted ahead of
  // any other top-level code in this module.
  if (existsSync(".env")) process.loadEnvFile(".env");

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed e2e staff fixtures: NODE_ENV is production.");
  }
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is not set");

  // Repoints process.env.DATABASE_URL at ammari_e2e using ONLY plain URL math — no import of
  // anything in @ammari/db yet. This has to happen BEFORE the very first import of
  // @ammari/db/test-e2e-db below: that module transitively imports ../src/client.ts, which
  // reads DATABASE_URL at module EVALUATION time (a top-level `const`) and gets cached by
  // Node's module system — if that first evaluation saw the real dev database's URL, every
  // later `@ammari/db` import in this same process (including the one further down, used to
  // seed the staff fixtures) would keep returning that same wrongly-pointed, already-cached
  // `db` singleton, silently writing e2e fixtures into the owner's real database. (This exact
  // bug shipped once already — see the cleanup note in this session's final report.)
  const e2eUrl = new URL(baseUrl);
  e2eUrl.pathname = "/ammari_e2e";
  const isLocalHost = e2eUrl.hostname === "localhost" || e2eUrl.hostname === "127.0.0.1";
  if (!isLocalHost) {
    throw new Error(`Refusing to seed e2e staff fixtures against non-local host "${e2eUrl.hostname}".`);
  }
  process.env.DATABASE_URL = e2eUrl.toString();

  // Creates (if needed), migrates, and baseline-seeds ammari_e2e. `baseUrl` is passed explicitly
  // (not read from process.env, which is already repointed above) so it can still connect to
  // the original database to issue CREATE DATABASE.
  const { ensureE2eDatabase } = await import("@ammari/db/test-e2e-db");
  await ensureE2eDatabase(baseUrl);
  assertSafeTarget();

  const { and, eq, inArray, notInArray } = await import("drizzle-orm");
  const { db } = await import("@ammari/db");
  const {
    roles,
    permissions,
    rolePermissions,
    staffUsers,
    authEmailThrottle,
    staffAuthRateLimits,
    fabrics,
    fabricColors,
    products,
    productVariants,
    stockMovements,
    orders,
    orderItems,
    payments,
    stockReservations,
  } = await import("@ammari/db/schema");
  const { OWNER_ROLE_KEY, SUPER_ADMIN_ROLE_KEY } = await import("@ammari/db/rbac");

  async function ensureStaffFixture(email: string, name: string, roleKey: string): Promise<void> {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, roleKey)).limit(1);
    if (!role) {
      throw new Error(`role "${roleKey}" is not seeded — run "pnpm --filter @ammari/db db:seed" first`);
    }
    // onConflictDoNothing, not check-then-write (CLAUDE.md) — idempotent across repeated runs.
    await db
      .insert(staffUsers)
      .values({ name, email, roleId: role.id })
      .onConflictDoNothing({ target: staffUsers.email });
  }

  /** Non-system role holding exactly `permissionKeys` — same insert-then-prune pattern as
   * packages/db/src/seed.ts's upsertSystemRole, so it stays race-safe across repeated runs. */
  async function ensureLimitedRole(roleKey: string, permissionKeys: readonly string[]): Promise<string> {
    const [role] = await db
      .insert(roles)
      .values({ key: roleKey, name: roleKey, isSystem: false })
      .onConflictDoUpdate({ target: roles.key, set: { name: roleKey } })
      .returning();
    if (!role) throw new Error(`failed to upsert role "${roleKey}"`);

    const permissionRows = await db.select({ id: permissions.id }).from(permissions).where(inArray(permissions.key, permissionKeys));
    const desiredIds = permissionRows.map((row) => row.id);
    if (desiredIds.length > 0) {
      await db
        .insert(rolePermissions)
        .values(desiredIds.map((permissionId) => ({ roleId: role.id, permissionId })))
        .onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] });
    }
    // Prune anything beyond the desired set (e.g. a previous run of this fixture with different
    // permissions) — insert-then-prune, not delete-then-insert, so this stays race-safe.
    await db
      .delete(rolePermissions)
      .where(
        desiredIds.length > 0
          ? and(eq(rolePermissions.roleId, role.id), notInArray(rolePermissions.permissionId, desiredIds))
          : eq(rolePermissions.roleId, role.id),
      );
    return role.id;
  }

  await ensureStaffFixture(E2E_SUPER_ADMIN_EMAIL, "E2E Super Admin", SUPER_ADMIN_ROLE_KEY);
  await ensureStaffFixture(E2E_OWNER_EMAIL, "E2E Owner", OWNER_ROLE_KEY);

  await ensureLimitedRole(E2E_LIMITED_ROLE_KEY, ["products.manage"]);
  await ensureStaffFixture(E2E_PRODUCTS_NO_FINANCE_EMAIL, "E2E Products (no finance)", E2E_LIMITED_ROLE_KEY);

  await ensureLimitedRole(E2E_PRODUCTION_STOCK_ROLE_KEY, [
    "products.manage",
    "production.manage",
    "stock.view",
    "stock.adjust",
    "finance.view_profit",
    "inventory.view",
    "inventory.manage",
    // Since purchase documents (docs/plans/suppliers-goods-receipt.md S3) raw-material stock only
    // arrives through a goods receipt, which needs its own key (D10).
    "inventory.receive",
  ]);
  await ensureStaffFixture(E2E_PRODUCTION_STOCK_EMAIL, "E2E Production & Stock", E2E_PRODUCTION_STOCK_ROLE_KEY);

  await ensureLimitedRole(E2E_ORDERS_ROLE_KEY, [
    "products.manage",
    "production.manage",
    "stock.view",
    "stock.adjust",
    "finance.view_profit",
    "inventory.view",
    "inventory.manage",
    // Since purchase documents (docs/plans/suppliers-goods-receipt.md S3) raw-material stock only
    // arrives through a goods receipt, which needs its own key (D10).
    "inventory.receive",
    "orders.view",
    "orders.manage",
  ]);
  await ensureStaffFixture(E2E_ORDERS_EMAIL, "E2E Orders", E2E_ORDERS_ROLE_KEY);
  await ensureStaffFixture(E2E_STOCK_RESERVATIONS_EMAIL, "E2E Stock Reservations", E2E_ORDERS_ROLE_KEY);

  await ensureLimitedRole(E2E_PACKING_ROLE_KEY, [
    "products.manage",
    "production.manage",
    "stock.view",
    "stock.adjust",
    "finance.view_profit",
    "inventory.view",
    "inventory.manage",
    // Since purchase documents (docs/plans/suppliers-goods-receipt.md S3) raw-material stock only
    // arrives through a goods receipt, which needs its own key (D10).
    "inventory.receive",
    "orders.view",
    "orders.manage",
    "packing.print_cards",
  ]);
  await ensureStaffFixture(E2E_PACKING_EMAIL, "E2E Packing", E2E_PACKING_ROLE_KEY);
  await ensureStaffFixture(E2E_CHECKOUT_ORDERS_EMAIL, "E2E Checkout Orders", E2E_PACKING_ROLE_KEY);
  await ensureStaffFixture(E2E_PACKING_PRINT_EMAIL, "E2E Packing Print", E2E_PACKING_ROLE_KEY);
  await ensureStaffFixture(E2E_PACKING_PRINT_WEBKIT_EMAIL, "E2E Packing Print WebKit", E2E_PACKING_ROLE_KEY);
  await ensureStaffFixture(E2E_PACKING_STICKERS_EMAIL, "E2E Packing Stickers", E2E_PACKING_ROLE_KEY);
  await ensureStaffFixture(E2E_PRODUCT_HIGHLIGHTS_EMAIL, "E2E Product Highlights", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_STOREFRONT_EMAIL, "E2E Storefront", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_VARIANT_PHOTOS_EMAIL, "E2E Variant Photos", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_FRESH_AFTER_SAVE_EMAIL, "E2E Fresh After Save", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_PRODUCT_DISCOUNT_EMAIL, "E2E Product Discount", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_PRODUCT_TYPES_EMAIL, "E2E Product Types", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_PRODUCT_STEPPER_EMAIL, "E2E Product Stepper", OWNER_ROLE_KEY);

  await ensureLimitedRole(E2E_SUPPLIERS_ROLE_KEY, ["inventory.view", "inventory.manage"]);
  await ensureStaffFixture(E2E_SUPPLIERS_EMAIL, "E2E Suppliers", E2E_SUPPLIERS_ROLE_KEY);
  await ensureStaffFixture(E2E_PAYMENTS_NO_FINANCE_EMAIL, "E2E Payments (no finance)", E2E_SUPPLIERS_ROLE_KEY);
  await ensureStaffFixture(E2E_SUPPLIER_PAYMENTS_EMAIL, "E2E Supplier Payments", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_PRODUCTION_PAYMENTS_EMAIL, "E2E Production Payments", OWNER_ROLE_KEY);
  await ensureLimitedRole(E2E_PRODUCTION_NO_FINANCE_ROLE_KEY, ["production.manage"]);
  await ensureStaffFixture(E2E_PRODUCTION_PAYMENTS_NO_FINANCE_EMAIL, "E2E Production Payments (no finance)", E2E_PRODUCTION_NO_FINANCE_ROLE_KEY);

  await ensureLimitedRole(E2E_PURCHASES_ROLE_KEY, [
    "products.manage",
    "finance.view_profit",
    "inventory.view",
    "inventory.manage",
    "inventory.receive",
  ]);
  await ensureStaffFixture(E2E_PURCHASES_EMAIL, "E2E Purchases", E2E_PURCHASES_ROLE_KEY);
  await ensureStaffFixture(E2E_RECEIPTS_EMAIL, "E2E Receipts", E2E_PURCHASES_ROLE_KEY);

  await ensureLimitedRole(E2E_DEFECTS_ROLE_KEY, [
    "products.manage",
    "production.manage",
    "stock.view",
    "stock.adjust",
    "finance.view_profit",
    "inventory.view",
    "inventory.manage",
    "inventory.receive",
  ]);
  await ensureStaffFixture(E2E_DEFECTS_EMAIL, "E2E Defects", E2E_DEFECTS_ROLE_KEY);
  await ensureStaffFixture(E2E_DISPOSITIONS_EMAIL, "E2E Dispositions", E2E_DEFECTS_ROLE_KEY);

  await ensureStaffFixture(E2E_LOGIN_OTP_EMAIL, "E2E Login OTP", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_LOGIN_OTP_MOBILE_EMAIL, "E2E Login OTP Mobile", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_LOGIN_OTP_RESEND_EMAIL, "E2E Login OTP Resend", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_LOGIN_OTP_EXPIRY_EMAIL, "E2E Login OTP Expiry", OWNER_ROLE_KEY);

  await ensureStaffFixture(E2E_OVERVIEW_EMAIL, "E2E Overview", OWNER_ROLE_KEY);
  await ensureStaffFixture(E2E_OVERVIEW_SETTINGS_EMAIL, "E2E Overview Settings", OWNER_ROLE_KEY);
  await ensureLimitedRole(E2E_OVERVIEW_NO_FINANCE_ROLE_KEY, ["overview.view", "orders.view", "stock.view", "inventory.view", "production.manage"]);
  await ensureStaffFixture(E2E_OVERVIEW_NO_FINANCE_EMAIL, "E2E Overview (no finance)", E2E_OVERVIEW_NO_FINANCE_ROLE_KEY);
  await ensureLimitedRole(E2E_SETTINGS_NO_FINANCE_ROLE_KEY, ["overview.view", "settings.manage"]);
  await ensureStaffFixture(E2E_SETTINGS_NO_FINANCE_EMAIL, "E2E Settings (no finance)", E2E_SETTINGS_NO_FINANCE_ROLE_KEY);

  const [paginationFabric] = await db
    .insert(fabrics)
    .values({ name: "E2E Pagination Fabric" })
    .onConflictDoNothing()
    .returning({ id: fabrics.id });
  const paginationFabricId =
    paginationFabric?.id ??
    (await db.select({ id: fabrics.id }).from(fabrics).where(eq(fabrics.name, "E2E Pagination Fabric")).limit(1))[0]?.id;
  if (!paginationFabricId) throw new Error("failed to seed the e2e pagination fixture fabric");

  for (let i = 0; i < E2E_PAGINATION_PRODUCT_COUNT; i += 1) {
    const suffix = String(i).padStart(2, "0");
    await db
      .insert(products)
      .values({
        name: `${E2E_PAGINATION_PRODUCT_PREFIX} ${suffix}`,
        code: `E2EPAGINATION${suffix}`,
        slug: `e2e-pagination-produk-${suffix}`,
        fabricId: paginationFabricId,
        closure: "front_zip",
        sizeMode: "sized",
        basePrice: 100_000,
      })
      .onConflictDoNothing({ target: products.slug });
  }
  await db
    .insert(products)
    .values({
      name: E2E_UNWEIGHED_PUBLISHED_PRODUCT_NAME,
      code: "E2ETANPABERAT",
      slug: "e2e-gamis-tanpa-berat",
      fabricId: paginationFabricId,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 269_000,
      isPublishedOnStorefront: true,
    })
    .onConflictDoNothing({ target: products.slug });

  // ammari_e2e is truncated at the start of every run (ensureE2eDatabase), so these are plain
  // inserts. Shaped like what web checkout writes (orders_checkout_fields_check): 5 physical pcs,
  // 2 held for 75 minutes, plus an expired hold that must not count.
  await db.transaction(async (tx) => {
    const [fabric] = await tx.insert(fabrics).values({ name: "E2E Dipesan Fabric" }).returning({ id: fabrics.id });
    if (!fabric) throw new Error("failed to seed the e2e reservation fabric");
    const [color] = await tx.insert(fabricColors).values({ fabricId: fabric.id, name: "Mocca" }).returning({ id: fabricColors.id });
    if (!color) throw new Error("failed to seed the e2e reservation colour");
    const [product] = await tx
      .insert(products)
      .values({
        name: E2E_RESERVATION_PRODUCT_NAME,
        code: "E2EDIPESAN",
        slug: "e2e-gamis-dipesan",
        fabricId: fabric.id,
        closure: "front_zip",
        sizeMode: "sized",
        basePrice: 259_000,
      })
      .returning({ id: products.id, closure: products.closure });
    if (!product) throw new Error("failed to seed the e2e reservation product");
    const variantBase = { productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: product.closure };
    await tx.insert(productVariants).values([
      { ...variantBase, sku: E2E_RESERVATION_HELD_SKU, size: "M" },
      { ...variantBase, sku: E2E_RESERVATION_FREE_SKU, size: "L" },
    ]);
    await tx.insert(stockMovements).values([
      { sku: E2E_RESERVATION_HELD_SKU, qty: 5, valueAmount: 500_000, type: "production", refType: "manual" },
      { sku: E2E_RESERVATION_FREE_SKU, qty: 3, valueAmount: 300_000, type: "production", refType: "manual" },
    ]);

    const now = Date.now();
    const checkoutOrder = (orderNo: string) => ({
      channelId: "web" as const,
      orderNo,
      status: "awaiting_payment" as const,
      paymentStatus: "pending" as const,
      paymentExpiresAt: new Date(now + 60 * 60_000),
      checkoutAttemptId: crypto.randomUUID(),
      termsAcceptedAt: new Date(now),
      promoOptIn: false,
      placedWithSession: false,
      orderDate: new Date(now),
      subtotalAmount: 518_000,
      discountAmount: 0,
      totalAmount: 518_000,
      // The locked quote every checkout order carries (migration 0031): fully subsidized.
      shippingAmount: 0,
      shippingCostAmount: 12_000,
      shippingSubsidyAmount: 12_000,
      shippingCourierCode: "jne",
      shippingServiceCode: "reg",
      shippingCourierLabel: "JNE Reguler",
      shippingWeightGrams: 1_900,
      shippingDestinationId: "e2e-destination",
      shippingQuotedAt: new Date(now),
    });
    for (const hold of [
      { orderNo: E2E_RESERVATION_ORDER_NO, expiresAt: new Date(now + 75 * 60_000) },
      { orderNo: "ORD-E2E-DIPESAN-EXPIRED", expiresAt: new Date(now - 60_000) },
    ]) {
      const [order] = await tx.insert(orders).values(checkoutOrder(hold.orderNo)).returning({ id: orders.id });
      if (!order) throw new Error("failed to seed the e2e reservation order");
      const [item] = await tx
        .insert(orderItems)
        .values({ orderId: order.id, sku: E2E_RESERVATION_HELD_SKU, qty: 2, unitPrice: 259_000, unitCost: 0 })
        .returning({ id: orderItems.id });
      if (!item) throw new Error("failed to seed the e2e reservation order item");
      await tx
        .insert(stockReservations)
        .values({ orderId: order.id, orderItemId: item.id, sku: E2E_RESERVATION_HELD_SKU, qty: 2, expiresAt: hold.expiresAt });
    }
  });

  // Ringkasan's backdated orders (see E2E_OVERVIEW_SKU above). 10:00 WIB is 03:00 UTC.
  await db.transaction(async (tx) => {
    const [fabric] = await tx.insert(fabrics).values({ name: "E2E Ringkasan Fabric" }).returning({ id: fabrics.id });
    if (!fabric) throw new Error("failed to seed the e2e overview fabric");
    const [color] = await tx.insert(fabricColors).values({ fabricId: fabric.id, name: "Navy" }).returning({ id: fabricColors.id });
    if (!color) throw new Error("failed to seed the e2e overview colour");
    const [product] = await tx
      .insert(products)
      .values({ name: "E2E Gamis Ringkasan", code: "E2ERINGKASAN", slug: "e2e-gamis-ringkasan", fabricId: fabric.id, closure: "front_zip", sizeMode: "sized", basePrice: 300_000 })
      .returning({ id: products.id, closure: products.closure });
    if (!product) throw new Error("failed to seed the e2e overview product");
    await tx.insert(productVariants).values({ productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: product.closure, sku: E2E_OVERVIEW_SKU, size: "M" });

    const jakartaToday = new Date(Date.now() + 7 * 60 * 60_000);
    const daysAgoAt10Wib = (days: number) =>
      new Date(Date.UTC(jakartaToday.getUTCFullYear(), jakartaToday.getUTCMonth(), jakartaToday.getUTCDate() - days, 3, 0));
    const seeds = [
      { orderNo: "ORD-E2E-RINGKASAN-1", daysAgo: 1, status: "completed" as const, unitPrice: 300_000, unitCost: 120_000, shipping: 15_000, discount: 0 },
      { orderNo: "ORD-E2E-RINGKASAN-2", daysAgo: 1, status: "shipped" as const, unitPrice: 250_000, unitCost: 0, shipping: 0, discount: 50_000 },
      { orderNo: "ORD-E2E-RINGKASAN-3", daysAgo: 1, status: "cancelled" as const, unitPrice: 259_000, unitCost: 0, shipping: 0, discount: 0 },
      { orderNo: "ORD-E2E-RINGKASAN-4", daysAgo: 2, status: "completed" as const, unitPrice: 250_000, unitCost: 100_000, shipping: 10_000, discount: 0 },
      { orderNo: E2E_OVERVIEW_LATE_ORDER_NO, daysAgo: 5, status: "to_ship" as const, unitPrice: 300_000, unitCost: 120_000, shipping: 0, discount: 0 },
    ];
    for (const seed of seeds) {
      const [order] = await tx
        .insert(orders)
        .values({
          channelId: "whatsapp",
          orderNo: seed.orderNo,
          status: seed.status,
          orderDate: daysAgoAt10Wib(seed.daysAgo),
          subtotalAmount: seed.unitPrice,
          shippingAmount: seed.shipping,
          discountAmount: seed.discount,
          totalAmount: seed.unitPrice + seed.shipping - seed.discount,
        })
        .returning({ id: orders.id });
      if (!order) throw new Error(`failed to seed ${seed.orderNo}`);
      await tx.insert(orderItems).values({ orderId: order.id, sku: E2E_OVERVIEW_SKU, qty: 1, unitPrice: seed.unitPrice, unitCost: seed.unitCost });
    }
  });

  // The discount product for product-discount.spec.ts (see E2E_PRODUCT_DISCOUNT_EMAIL above).
  await db.transaction(async (tx) => {
    const [fabric] = await tx.insert(fabrics).values({ name: "E2E Diskon Fabric" }).returning({ id: fabrics.id });
    if (!fabric) throw new Error("failed to seed the e2e discount fabric");
    const [color] = await tx.insert(fabricColors).values({ fabricId: fabric.id, name: "Dusty" }).returning({ id: fabricColors.id });
    if (!color) throw new Error("failed to seed the e2e discount colour");
    const [product] = await tx
      .insert(products)
      .values({ name: E2E_DISCOUNT_PRODUCT_NAME, code: "E2EDISKON", slug: "e2e-gamis-diskon", fabricId: fabric.id, closure: "front_zip", sizeMode: "sized", basePrice: 350_000 })
      .returning({ id: products.id, closure: products.closure });
    if (!product) throw new Error("failed to seed the e2e discount product");
    await tx.insert(productVariants).values({ productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: product.closure, sku: E2E_DISCOUNT_SKU, size: "M" });

    // An unpaid checkout order with a discounted line (see E2E_DISCOUNT_ORDER_NO above). Nothing
    // is held or sold for it: the detail page is all the spec reads.
    const placedAt = new Date();
    const [order] = await tx
      .insert(orders)
      .values({
        channelId: "web",
        orderNo: E2E_DISCOUNT_ORDER_NO,
        status: "awaiting_payment",
        paymentStatus: "pending",
        checkoutAttemptId: crypto.randomUUID(),
        termsAcceptedAt: placedAt,
        promoOptIn: false,
        placedWithSession: false,
        orderDate: placedAt,
        subtotalAmount: 558_000,
        shippingAmount: 15_000,
        discountAmount: 20_000,
        totalAmount: 553_000,
        contactEmail: "pembeli-diskon@e2e.ammari.test",
        contactPhone: "+6281234567890",
        recipientName: "Siti Aminah",
        shippingAddress: "Siti Aminah, +6281298765432, Jl. Mawar 1, Coblong, Kota Bandung, Jawa Barat 40132",
        shippingAddressSnapshot: {
          version: 2,
          recipientName: "Siti Aminah",
          phone: "+6281298765432",
          addressLine: "Jl. Mawar 1, RT 01/RW 02, Kel. Sukamaju",
          notes: null,
          shippingAreaId: null,
          providerAreaId: "e2e-destination",
          province: "Jawa Barat",
          city: "Kota Bandung",
          district: "Coblong",
          subdistrict: null,
          postalCode: "40132",
        },
        paymentExpiresAt: new Date(placedAt.getTime() + 60 * 60_000),
        shippingCostAmount: 35_000,
        shippingSubsidyAmount: 20_000,
        shippingCourierCode: "jne",
        shippingServiceCode: "reg",
        shippingCourierLabel: "JNE Reguler",
        shippingWeightGrams: 1_500,
        shippingDestinationId: "e2e-destination",
        shippingQuotedAt: placedAt,
      })
      .returning({ id: orders.id });
    if (!order) throw new Error("failed to seed the e2e discount order");
    await tx.insert(orderItems).values({ orderId: order.id, sku: E2E_DISCOUNT_SKU, qty: 2, unitPrice: 279_000, listUnitPrice: 350_000, unitCost: 0 });
    await tx.insert(payments).values({
      orderId: order.id,
      provider: "midtrans",
      providerOrderId: `E2E-${E2E_DISCOUNT_ORDER_NO}-1`,
      attempt: 1,
      grossAmount: 553_000,
      status: "pending",
      expiresAt: new Date(placedAt.getTime() + 60 * 60_000),
    });
  });

  // Web checkout orders for checkout-orders.spec.ts (see E2E_CHECKOUT_ORDERS_EMAIL above).
  await db.transaction(async (tx) => {
    const [fabric] = await tx.insert(fabrics).values({ name: "E2E Web Fabric" }).returning({ id: fabrics.id });
    if (!fabric) throw new Error("failed to seed the e2e web fabric");
    const [color] = await tx.insert(fabricColors).values({ fabricId: fabric.id, name: "Sage" }).returning({ id: fabricColors.id });
    if (!color) throw new Error("failed to seed the e2e web colour");
    const [product] = await tx
      .insert(products)
      .values({ name: E2E_CHECKOUT_PRODUCT_NAME, code: "E2EWEB", slug: "e2e-gamis-web", fabricId: fabric.id, closure: "front_zip", sizeMode: "sized", basePrice: 259_000 })
      .returning({ id: products.id, closure: products.closure });
    if (!product) throw new Error("failed to seed the e2e web product");
    await tx.insert(productVariants).values({ productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: product.closure, sku: E2E_CHECKOUT_SKU, size: "M" });
    await tx.insert(stockMovements).values({ sku: E2E_CHECKOUT_SKU, qty: 20, valueAmount: 2_000_000, type: "production", refType: "manual" });

    const now = Date.now();
    // Rp35.000 courier cost: Rp20.000 subsidy, Rp15.000 paid by the buyer.
    const total = 259_000 + 15_000;
    const base = (orderNo: string) => ({
      channelId: "web" as const,
      orderNo,
      checkoutAttemptId: crypto.randomUUID(),
      termsAcceptedAt: new Date(now),
      promoOptIn: true,
      placedWithSession: false,
      orderDate: new Date(now),
      subtotalAmount: 259_000,
      discountAmount: 0,
      totalAmount: total,
      contactEmail: "pembeli-web@e2e.ammari.test",
      contactPhone: "+6281234567890",
      recipientName: "Siti Aminah",
      shippingAddress: "Siti Aminah, +6281298765432, Jl. Mawar 1, Coblong, Kota Bandung, Jawa Barat 40132",
      shippingAddressSnapshot: {
        version: 2,
        recipientName: "Siti Aminah",
        phone: "+6281298765432",
        addressLine: "Jl. Mawar 1, RT 01/RW 02, Kel. Sukamaju",
        notes: null,
        shippingAreaId: null,
        providerAreaId: "e2e-destination",
        province: "Jawa Barat",
        city: "Kota Bandung",
        district: "Coblong",
        subdistrict: null,
        postalCode: "40132",
      },
      paymentExpiresAt: new Date(now + 60 * 60_000),
      shippingAmount: 15_000,
      shippingCostAmount: 35_000,
      shippingSubsidyAmount: 20_000,
      shippingCourierCode: "jne",
      shippingServiceCode: "reg",
      shippingCourierLabel: "JNE Reguler",
      shippingWeightGrams: 900,
      shippingDestinationId: "e2e-destination",
      shippingQuotedAt: new Date(now),
    });

    for (const layout of E2E_CHECKOUT_LAYOUTS) {
      const seeds = [
        { kind: "pending" as const, status: "awaiting_payment" as const, paid: false, sold: false, flags: [] as ("stock_short_at_payment" | "payment_anomaly")[] },
        { kind: "paid" as const, status: "to_ship" as const, paid: true, sold: true, flags: [] as ("stock_short_at_payment" | "payment_anomaly")[] },
        { kind: "short" as const, status: "awaiting_payment" as const, paid: true, sold: false, flags: ["stock_short_at_payment" as const] },
        { kind: "flagged" as const, status: "to_ship" as const, paid: true, sold: true, flags: ["payment_anomaly" as const] },
        { kind: "ship" as const, status: "to_ship" as const, paid: true, sold: true, flags: [] as ("stock_short_at_payment" | "payment_anomaly")[] },
        { kind: "noresi" as const, status: "shipped" as const, paid: true, sold: true, flags: [] as ("stock_short_at_payment" | "payment_anomaly")[] },
        { kind: "book" as const, status: "to_ship" as const, paid: true, sold: true, flags: [] as ("stock_short_at_payment" | "payment_anomaly")[], destination: E2E_BOOKING_AREA },
        { kind: "lost" as const, status: "to_ship" as const, paid: true, sold: true, flags: [] as ("stock_short_at_payment" | "payment_anomaly")[], destination: E2E_LOST_ANSWER_AREA },
      ];
      for (const seed of seeds) {
        const orderNo = e2eCheckoutOrderNo(seed.kind, layout);
        const [order] = await tx
          .insert(orders)
          .values({
            ...base(orderNo),
            status: seed.status,
            paymentStatus: seed.paid ? "paid" : "pending",
            paidAt: seed.paid ? new Date(now) : null,
            needsAttention: seed.flags,
            ...("destination" in seed ? { shippingDestinationId: seed.destination } : {}),
            ...(seed.status === "shipped" ? { shippedAt: new Date(now), courier: "J&T Reguler", trackingNumber: null } : {}),
          })
          .returning({ id: orders.id });
        if (!order) throw new Error(`failed to seed ${orderNo}`);
        const [item] = await tx
          .insert(orderItems)
          .values({ orderId: order.id, sku: E2E_CHECKOUT_SKU, qty: 1, unitPrice: 259_000, unitCost: seed.sold ? 100_000 : 0 })
          .returning({ id: orderItems.id });
        if (!item) throw new Error(`failed to seed ${orderNo}'s line`);
        if (seed.sold) {
          await tx.insert(stockMovements).values({ sku: E2E_CHECKOUT_SKU, qty: -1, valueAmount: -100_000, type: "sale", refType: "order_item", refId: item.id });
        }
        await tx.insert(stockReservations).values({
          orderId: order.id,
          orderItemId: item.id,
          sku: E2E_CHECKOUT_SKU,
          qty: 1,
          expiresAt: new Date(now + 75 * 60_000),
          ...(seed.sold ? { status: "consumed" as const, consumedAt: new Date(now) } : seed.paid ? { status: "released" as const, releasedAt: new Date(now) } : {}),
        });
        await tx.insert(payments).values({
          orderId: order.id,
          provider: "midtrans",
          providerOrderId: `E2E-${orderNo}-1`,
          attempt: 1,
          grossAmount: total,
          status: seed.paid ? "paid" : "pending",
          paymentType: seed.paid ? "qris" : null,
          paidAt: seed.paid ? new Date(now) : null,
          snapToken: "e2e-snap-token",
          redirectUrl: "http://localhost:3000/api/test/payments/e2e",
          expiresAt: new Date(now + 60 * 60_000),
          lastStatus: seed.paid ? { transaction_status: "settlement", payment_type: "qris" } : null,
        });
      }
    }
  });

  // Clears rate-limit state left over from a previous run (repeated runs within the same
  // 5-minute window would otherwise throttle out the fixture logins below). Test-only infra
  // against a local DB — never touches anything in a real environment.
  await db
    .delete(authEmailThrottle)
    .where(
      inArray(authEmailThrottle.email, [
        E2E_SUPER_ADMIN_EMAIL,
        E2E_OWNER_EMAIL,
        E2E_PRODUCTS_NO_FINANCE_EMAIL,
        E2E_PRODUCTION_STOCK_EMAIL,
        E2E_ORDERS_EMAIL,
        E2E_STOCK_RESERVATIONS_EMAIL,
        E2E_CHECKOUT_ORDERS_EMAIL,
        E2E_PACKING_EMAIL,
        E2E_PACKING_PRINT_EMAIL,
        E2E_PACKING_PRINT_WEBKIT_EMAIL,
        E2E_PURCHASES_EMAIL,
        E2E_RECEIPTS_EMAIL,
        E2E_DEFECTS_EMAIL,
        E2E_DISPOSITIONS_EMAIL,
        E2E_VARIANT_PHOTOS_EMAIL,
        E2E_FRESH_AFTER_SAVE_EMAIL,
        E2E_PRODUCT_DISCOUNT_EMAIL,
        E2E_PRODUCT_TYPES_EMAIL,
      ]),
    );
  await db.delete(staffAuthRateLimits);

  // Last, so a failed seed above never leaves the port held. Playwright calls the returned
  // function as the global teardown.
  return startStorefrontStub(process.env.REVALIDATE_SECRET);
}

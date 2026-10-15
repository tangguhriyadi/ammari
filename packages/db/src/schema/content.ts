import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { checkIn, timestamps } from "./columns";
import { HOMEPAGE_SECTION_KEYS, SIZES, type Size } from "./constants";
import { staffUsers } from "./rbac";

// ---------- Homepage content (docs/plans/storefront-cms.md, migration 0019) ----------

// One row per fixed section key — NOT a generic page builder. Draft/publish is modeled as two
// parallel JSONB columns on the SAME row, not a child table per section (tiles, "Kenapa Ammari"
// points): this content is edited by exactly one person at a time, never joined against by
// anything else, and its "child rows" have no identity or lifecycle of their own — same
// reasoning this schema already applies to products.highlights (a plain array, not a child
// table). This shape also makes "publish every section atomically" a single
// `UPDATE ... WHERE key = ANY(...)` in one transaction, not a copy-step across several child
// tables per section. Each `*_content` value is validated by a per-key Zod schema at save time
// (app code, a later session) — never trusted as-is from the client, and NOT enforced by a DB
// CHECK here (Postgres JSONB has no per-shape constraint short of a much larger hand-written
// CHECK expression, which would just duplicate the Zod schema in SQL).
//
// The 4 rows (one per HOMEPAGE_SECTION_KEYS key) are seeded by migration 0019 itself, not
// seed.ts — CLAUDE.md's "reference data the code depends on ships in a migration" rule: the
// storefront needs these rows to exist in order to render at all (the renderer, session 7,
// simply reads 4 rows and skips any that are hidden/unpublished), same category as a permission
// key or a channel id. Seeded with an empty `{}` placeholder `draft_content`/`published_content`
// left null (unpublished) — not a shape that already satisfies the future save-time Zod schema,
// since nothing reads or renders this column yet and locking in a shape here would only risk
// drifting from whatever that schema ends up being.
export const storefrontHomepageSections = pgTable(
  "storefront_homepage_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    draftIsVisible: boolean("draft_is_visible").notNull().default(true),
    draftContent: jsonb("draft_content").notNull().default({}),
    // Bumped by application code on every draft save (not a DB trigger) — a single-column
    // "last touched" timestamp, distinct from the `timestamps()` helper's created/updated pair
    // (this table has no created_at; a section row is never "created" by a user action, only
    // seeded once).
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // Null until the first "Terbitkan" — see getPublishedHomepageContent (storefront/queries.ts),
    // which treats a null published_content/published_is_visible as "never published, render
    // nothing for this section."
    publishedIsVisible: boolean("published_is_visible"),
    publishedContent: jsonb("published_content"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    publishedByStaffUserId: uuid("published_by_staff_user_id").references(() => staffUsers.id, {
      onDelete: "restrict",
    }),
  },
  (table) => [
    check("storefront_homepage_sections_key_check", checkIn(table.key, HOMEPAGE_SECTION_KEYS)),
    index("storefront_homepage_sections_published_by_staff_user_id_idx").on(table.publishedByStaffUserId),
  ],
);

// ---------- Size charts (docs/plans/storefront-cms.md, migration 0019) ----------

// A reusable, named group of size_chart_rows that a product points to (products.size_chart_id,
// see catalog.ts) — most products likely share one chart, nothing forces it.
export const sizeCharts = pgTable("size_charts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...timestamps(),
});

// Fixed measurement columns, not admin-defined ones — replaces an earlier
// columns/values-parallel-array design that needed app-level "same length as the parent's
// column list" validation; a plain relational table with named, individually-CHECKed columns is
// simpler and safer now that the 4 measurements are fixed. `size` excludes ALLSIZE: an
// `all_size` product has nothing to tabulate (products.allsize_fit_note is shown instead).
export const sizeChartRows = pgTable(
  "size_chart_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sizeChartId: uuid("size_chart_id")
      .notNull()
      .references(() => sizeCharts.id, { onDelete: "cascade" }),
    size: text("size").$type<Size>().notNull(),
    bustCm: integer("bust_cm").notNull(), // Lingkar dada
    lengthCm: integer("length_cm").notNull(), // Panjang gamis
    sleeveLengthCm: integer("sleeve_length_cm").notNull(), // Panjang lengan
    // Rekomendasi tinggi badan, stored as two integers (CHECK max >= min) rather than a single
    // pre-formatted "150-160" string, so the range stays queryable/validated instead of being
    // baked into display text at write time — the PDP formats it as "150-160 cm", or just
    // "150 cm" when min = max.
    heightRecommendationMinCm: integer("height_recommendation_min_cm").notNull(),
    heightRecommendationMaxCm: integer("height_recommendation_max_cm").notNull(),
    ...timestamps(),
  },
  (table) => [
    index("size_chart_rows_size_chart_id_idx").on(table.sizeChartId),
    unique("size_chart_rows_size_chart_id_size_key").on(table.sizeChartId, table.size),
    check("size_chart_rows_size_check", checkIn(table.size, SIZES)),
    check("size_chart_rows_size_not_allsize_check", sql`${table.size} <> 'ALLSIZE'`),
    check("size_chart_rows_bust_cm_check", sql`${table.bustCm} > 0`),
    check("size_chart_rows_length_cm_check", sql`${table.lengthCm} > 0`),
    check("size_chart_rows_sleeve_length_cm_check", sql`${table.sleeveLengthCm} > 0`),
    check("size_chart_rows_height_recommendation_min_cm_check", sql`${table.heightRecommendationMinCm} > 0`),
    check("size_chart_rows_height_recommendation_max_cm_check", sql`${table.heightRecommendationMaxCm} > 0`),
    check(
      "size_chart_rows_height_recommendation_range_check",
      sql`${table.heightRecommendationMaxCm} >= ${table.heightRecommendationMinCm}`,
    ),
  ],
);

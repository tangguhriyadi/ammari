-- Hand-authored, data only (no schema change): backfills the default alt text into every product
-- photo whose alt text is empty. The default is "<product name>" for a general photo and
-- "<product name> warna <color name>" for a color photo, the exact string apps/admin's
-- lib/products/alt-text.ts (defaultImageAltText) builds for new uploads. Keep the two identical:
-- a later product/color rename only rewrites alt texts that still equal the old default.
--
-- Idempotent: only rows that are NULL or whitespace-only (any of space, tab, newline, CR, FF, VT)
-- are touched, so re-running it changes nothing. Never overwrites an alt text the owner typed.
--
-- Backward compatibility with the previous release (CLAUDE.md expand/contract): no column, type
-- or constraint changes. The previous release already reads/writes product_images.alt_text as a
-- nullable text column and treats any non-empty value as valid, so it keeps working unchanged;
-- a blank it writes during the deploy window is filled at publish time by the new release
-- (image-queries.ts's fillMissingAltTexts). Rollback leaves the filled values in place, which the
-- previous release handles like any hand-typed alt text.
UPDATE "product_images"
SET "alt_text" = (SELECT "products"."name" FROM "products" WHERE "products"."id" = "product_images"."product_id")
  || coalesce(
    (SELECT ' warna ' || "fabric_colors"."name" FROM "fabric_colors" WHERE "fabric_colors"."id" = "product_images"."fabric_color_id"),
    ''
  )
WHERE "product_images"."alt_text" IS NULL OR "product_images"."alt_text" ~ '^[[:space:]]*$';

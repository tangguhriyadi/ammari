import "server-only";
import { sql } from "drizzle-orm";
import type { Size, TikTokSkuMappingSource } from "@ammari/db/schema";
import { writeAuditLog, type Database } from "../db";

// Pemetaan SKU TikTok (docs/plans/tiktok-shop-integration.md §3.3, decided Q12; T4): one TikTok SKU
// = one Ammari variant (the primary key), two TikTok SKUs may point at the same variant. The
// auto-map lives with the snapshot store (order-store.ts); here are a person's map / remove and the
// page's reads. Every change is audited (`tiktok_sku_map`, `tiktok_sku_unmap`). Changing a mapping
// never rewrites an applied order (T5 locks lines once stock has left); in T4 nothing is applied.
//
// Concurrency: a map or remove takes `pg_advisory_xact_lock(hashtext('tiktok-sku:' || id))`, reads
// the row under it for the audit's "before", and writes with one INSERT ... ON CONFLICT DO UPDATE /
// conditional UPDATE ... RETURNING. The auto-map's ON CONFLICT DO NOTHING never overwrites it.

const ENTITY = "tiktok_sku_mapping";
const SKU_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

type MappingRow = {
  tiktok_sku_id: string;
  tiktok_product_id: string | null;
  seller_sku: string | null;
  variant_sku: string;
  source: TikTokSkuMappingSource;
  is_active: boolean;
};

function auditView(row: MappingRow) {
  return { tiktokSkuId: row.tiktok_sku_id, tiktokProductId: row.tiktok_product_id, sellerSku: row.seller_sku, variantSku: row.variant_sku, source: row.source, isActive: row.is_active };
}

export type MapTikTokSkuResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "invalid_sku_id" | "unknown_tiktok_sku" | "variant_not_found" };

/** The line of the most recently updated order that carries this TikTok SKU: where the product id
 * and the seller SKU of a manual mapping come from (never from the browser). */
const seenLineSql = (tiktokSkuId: string) => sql`
  select li->>'product_id' as product_id, li->>'seller_sku' as seller_sku
  from tiktok_orders o
  join tiktok_order_snapshots s on s.id = o.latest_snapshot_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(s.payload->'line_items') = 'array' then s.payload->'line_items' else '[]'::jsonb end) li
  where li->>'sku_id' = ${tiktokSkuId}
  order by o.latest_update_time desc
  limit 1
`;

/** Maps a TikTok SKU the sync has seen (or one already mapped) to an existing Ammari variant. */
export async function mapTikTokSku(db: Database, input: { tiktokSkuId: string; variantSku: string; staffUserId: string }): Promise<MapTikTokSkuResult> {
  const tiktokSkuId = input.tiktokSkuId.trim();
  if (!SKU_ID_PATTERN.test(tiktokSkuId)) return { ok: false, reason: "invalid_sku_id" };
  const variantSku = input.variantSku.trim();
  return db.transaction(async (tx): Promise<MapTikTokSkuResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-sku:${tiktokSkuId}`}))`);
    const [variant] = await tx.execute<{ sku: string }>(sql`select sku from product_variants where sku = ${variantSku} for key share`);
    if (!variant) return { ok: false, reason: "variant_not_found" };
    const [before] = await tx.execute<MappingRow>(sql`select tiktok_sku_id, tiktok_product_id, seller_sku, variant_sku, source, is_active from tiktok_sku_mappings where tiktok_sku_id = ${tiktokSkuId}`);
    const [seen] = await tx.execute<{ product_id: string | null; seller_sku: string | null }>(seenLineSql(tiktokSkuId));
    if (!before && !seen) return { ok: false, reason: "unknown_tiktok_sku" };
    if (before && before.is_active && before.variant_sku === variantSku && before.source === "manual") return { ok: true, changed: false };

    const [after] = await tx.execute<MappingRow>(sql`
      insert into tiktok_sku_mappings as m (tiktok_sku_id, tiktok_product_id, seller_sku, variant_sku, source, mapped_by_staff_user_id, mapped_at, is_active)
      values (${tiktokSkuId}, ${seen?.product_id ?? null}, ${seen?.seller_sku ?? null}, ${variantSku}, 'manual', ${input.staffUserId}::uuid, now(), true)
      on conflict (tiktok_sku_id) do update set
        tiktok_product_id = coalesce(excluded.tiktok_product_id, m.tiktok_product_id),
        seller_sku = coalesce(excluded.seller_sku, m.seller_sku),
        variant_sku = excluded.variant_sku,
        source = 'manual',
        mapped_by_staff_user_id = excluded.mapped_by_staff_user_id,
        mapped_at = now(),
        is_active = true,
        updated_at = now()
      returning tiktok_sku_id, tiktok_product_id, seller_sku, variant_sku, source, is_active
    `);
    await writeAuditLog(tx, {
      actorStaffUserId: input.staffUserId,
      action: "tiktok_sku_map",
      entityType: ENTITY,
      entityId: tiktokSkuId,
      before: before ? auditView(before) : null,
      after: auditView(after!),
    });
    return { ok: true, changed: true };
  });
}

export type UnmapTikTokSkuResult = { ok: true } | { ok: false; reason: "not_mapped" };

/** "Hapus pemetaan": the row stays (history), inactive, so the auto-map never brings it back. */
export async function unmapTikTokSku(db: Database, input: { tiktokSkuId: string; staffUserId: string }): Promise<UnmapTikTokSkuResult> {
  const tiktokSkuId = input.tiktokSkuId.trim();
  if (!SKU_ID_PATTERN.test(tiktokSkuId)) return { ok: false, reason: "not_mapped" };
  return db.transaction(async (tx): Promise<UnmapTikTokSkuResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-sku:${tiktokSkuId}`}))`);
    // The actor check (manual ⇔ a staff id) keeps `source`; who removed it is in the audit row.
    const [after] = await tx.execute<MappingRow>(sql`
      update tiktok_sku_mappings set is_active = false, updated_at = now()
      where tiktok_sku_id = ${tiktokSkuId} and is_active
      returning tiktok_sku_id, tiktok_product_id, seller_sku, variant_sku, source, is_active
    `);
    if (!after) return { ok: false, reason: "not_mapped" };
    await writeAuditLog(tx, {
      actorStaffUserId: input.staffUserId,
      action: "tiktok_sku_unmap",
      entityType: ENTITY,
      entityId: tiktokSkuId,
      before: auditView({ ...after, is_active: true }),
      after: auditView(after),
    });
    return { ok: true };
  });
}

// ---- Reads for the page ---------------------------------------------------------------------

export interface UnmappedTikTokSku {
  tiktokSkuId: string;
  tiktokProductId: string | null;
  sellerSku: string | null;
  productName: string | null;
  skuName: string | null;
  /** Orders not yet in admin whose latest version carries it. */
  orderCount: number;
  lastSeenAt: Date;
}

export const UNMAPPED_TIKTOK_SKU_LIMIT = 200;

/** TikTok SKUs on orders not yet applied to admin (and not cancelled) with no active mapping, most
 * recently seen first. Names come from the latest order that carries the SKU. */
export async function listUnmappedTikTokSkus(db: Database, limit = UNMAPPED_TIKTOK_SKU_LIMIT): Promise<UnmappedTikTokSku[]> {
  const rows = await db.execute<{
    sku_id: string;
    product_id: string | null;
    seller_sku: string | null;
    product_name: string | null;
    sku_name: string | null;
    order_count: number;
    last_seen_at: string | Date;
  }>(sql`
    with lines as (
      select o.tiktok_order_id, o.latest_update_time, li
      from tiktok_orders o
      join tiktok_order_snapshots s on s.id = o.latest_snapshot_id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(s.payload->'line_items') = 'array' then s.payload->'line_items' else '[]'::jsonb end) li
      where o.order_id is null and o.status <> 'CANCELLED' and jsonb_typeof(li) = 'object' and coalesce(li->>'sku_id', '') <> ''
    )
    select li->>'sku_id' as sku_id,
           (array_agg(li->>'product_id' order by latest_update_time desc))[1] as product_id,
           (array_agg(li->>'seller_sku' order by latest_update_time desc))[1] as seller_sku,
           (array_agg(li->>'product_name' order by latest_update_time desc))[1] as product_name,
           (array_agg(li->>'sku_name' order by latest_update_time desc))[1] as sku_name,
           count(distinct tiktok_order_id)::int as order_count,
           max(latest_update_time) as last_seen_at
    from lines
    where not exists (select 1 from tiktok_sku_mappings m where m.tiktok_sku_id = lines.li->>'sku_id' and m.is_active)
    group by li->>'sku_id'
    order by max(latest_update_time) desc, li->>'sku_id'
    limit ${limit}
  `);
  return rows.map((row) => ({
    tiktokSkuId: row.sku_id,
    tiktokProductId: row.product_id,
    sellerSku: row.seller_sku,
    productName: row.product_name,
    skuName: row.sku_name,
    orderCount: Number(row.order_count),
    lastSeenAt: new Date(row.last_seen_at),
  }));
}

export interface TikTokSkuMappingView {
  tiktokSkuId: string;
  tiktokProductId: string | null;
  sellerSku: string | null;
  variantSku: string;
  productName: string;
  colorName: string;
  size: Size;
  source: TikTokSkuMappingSource;
  mappedByName: string | null;
  mappedAt: Date;
}

export const TIKTOK_SKU_MAPPING_LIST_LIMIT = 500;

/** Active mappings, most recent first. */
export async function listTikTokSkuMappings(db: Database, limit = TIKTOK_SKU_MAPPING_LIST_LIMIT): Promise<TikTokSkuMappingView[]> {
  const rows = await db.execute<{
    tiktok_sku_id: string;
    tiktok_product_id: string | null;
    seller_sku: string | null;
    variant_sku: string;
    product_name: string;
    color_name: string;
    size: Size;
    source: TikTokSkuMappingSource;
    mapped_by_name: string | null;
    mapped_at: string | Date;
  }>(sql`
    select m.tiktok_sku_id, m.tiktok_product_id, m.seller_sku, m.variant_sku, p.name as product_name, fc.name as color_name, pv.size,
           m.source, su.name as mapped_by_name, m.mapped_at
    from tiktok_sku_mappings m
    join product_variants pv on pv.sku = m.variant_sku
    join products p on p.id = pv.product_id
    join fabric_colors fc on fc.id = pv.fabric_color_id
    left join staff_users su on su.id = m.mapped_by_staff_user_id
    where m.is_active
    order by m.mapped_at desc, m.tiktok_sku_id
    limit ${limit}
  `);
  return rows.map((row) => ({
    tiktokSkuId: row.tiktok_sku_id,
    tiktokProductId: row.tiktok_product_id,
    sellerSku: row.seller_sku,
    variantSku: row.variant_sku,
    productName: row.product_name,
    colorName: row.color_name,
    size: row.size,
    source: row.source,
    mappedByName: row.mapped_by_name,
    mappedAt: new Date(row.mapped_at),
  }));
}

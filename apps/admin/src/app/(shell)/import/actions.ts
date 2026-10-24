"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import type { ActionResult } from "@/lib/action-result";
import { revalidateAdmin, revalidateOverview } from "@/lib/admin-revalidate";
import { revalidateStorefrontForSkus } from "@/lib/storefront-stock";
import { BUSY_MESSAGE, commitImport, NOTHING_TO_SAVE_MESSAGE, STALE_PREVIEW_MESSAGE } from "@/lib/marketplace-import/commit";
import { E2E_MAPPING_UNLOCK_COOKIE, e2eMappingUnlocked } from "@/lib/marketplace-import/e2e-unlock";
import { MAX_FILE_BYTES } from "@/lib/marketplace-import/limits";
import { parseMarketplaceFile, type ParsedImport } from "@/lib/marketplace-import/parse-file";
import { MAX_SKU_OVERRIDES, planImport } from "@/lib/marketplace-import/plan";
import { toImportPreview, type ImportPreview } from "@/lib/marketplace-import/preview-view";
import { searchMatchVariants, type MatchVariantOption } from "@/lib/marketplace-import/variant-search";

// /import (docs/plans/marketplace-import.md §1, §12, sessions 4 and 5). Every action checks
// `orders.import` on the server; money in the preview needs `finance.view_profit` too and is left out
// of the payload otherwise (preview-view.ts). The uploaded file lives only in this request's memory:
// never stored, never logged; the browser sends it again with Simpan.

const FILE_MISSING = "Pilih file export dulu.";
const FILE_TOO_LARGE = "File terlalu besar (maks. 10 MB). Export per rentang tanggal yang lebih pendek.";
const INVALID_INPUT = "Data tidak valid. Muat ulang halaman lalu periksa file lagi.";

const channelSchema = z.enum(["shopee", "tiktok"]);
const skuText = z.string().trim().min(1).max(64);
const overridesSchema = z
  .record(skuText, skuText)
  .refine((value) => Object.keys(value).length <= MAX_SKU_OVERRIDES, `Terlalu banyak pencocokan SKU (maks. ${MAX_SKU_OVERRIDES}).`);

interface Upload {
  channelId: z.infer<typeof channelSchema>;
  fileName: string;
  bytes: Uint8Array;
  skuOverrides: Record<string, string>;
}

function text(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

async function readUpload(formData: FormData): Promise<{ ok: true; value: Upload } | { ok: false; error: string }> {
  const channel = channelSchema.safeParse(text(formData, "channel"));
  if (!channel.success) return { ok: false, error: "Pilih kanal." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: FILE_MISSING };
  // Checked before the bytes are read (the reader checks again on the bytes themselves).
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: FILE_TOO_LARGE };

  let rawOverrides: unknown = {};
  const overridesText = text(formData, "skuOverrides");
  if (overridesText) {
    if (overridesText.length > 100_000) return { ok: false, error: INVALID_INPUT };
    try {
      rawOverrides = JSON.parse(overridesText);
    } catch {
      return { ok: false, error: INVALID_INPUT };
    }
  }
  const overrides = overridesSchema.safeParse(rawOverrides);
  if (!overrides.success) return { ok: false, error: overrides.error.issues[0]?.message ?? INVALID_INPUT };

  return { ok: true, value: { channelId: channel.data, fileName: file.name.slice(0, 200) || "file", bytes: new Uint8Array(await file.arrayBuffer()), skuOverrides: overrides.data } };
}

async function parseUpload(upload: Upload): Promise<{ ok: true; parsed: ParsedImport } | { ok: false; error: string }> {
  const unlock = e2eMappingUnlocked({
    nodeEnv: process.env.NODE_ENV,
    e2eTestLoginFlag: process.env.E2E_TEST_LOGIN,
    cookieValue: (await cookies()).get(E2E_MAPPING_UNLOCK_COOKIE)?.value,
    channelId: upload.channelId,
  });
  const result = parseMarketplaceFile({ channelId: upload.channelId, fileName: upload.fileName, bytes: upload.bytes, assumeMappingVerified: unlock });
  return result.ok ? { ok: true, parsed: result.value } : { ok: false, error: result.error.message };
}

/** Periksa file: parse + plan, nothing written. */
export async function previewImportAction(formData: FormData): Promise<ActionResult<ImportPreview>> {
  const session = await requirePermission("orders.import");
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const upload = await readUpload(formData);
  if (!upload.ok) return { ok: false, error: upload.error };
  const parsed = await parseUpload(upload.value);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const planned = await planImport(parsed.parsed, { skuOverrides: upload.value.skuOverrides });
  if (!planned.ok) return { ok: false, error: planned.error.message };
  return { ok: true, data: toImportPreview(parsed.parsed, planned.value, { canViewProfit }) };
}

export type CommitImportResult =
  | { kind: "committed"; batchId: string; created: number; updated: number; reviewCount: number; storefrontOk: boolean }
  /** Nothing was written; `preview` is what is true now. */
  | { kind: "not_saved"; reason: "stale" | "blocked" | "nothing_to_save"; message: string; preview: ImportPreview };

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Simpan: the same file and matches again, plus the digest of the preview the owner saw. */
export async function commitImportAction(formData: FormData): Promise<ActionResult<CommitImportResult>> {
  const session = await requirePermission("orders.import");
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const digest = digestSchema.safeParse(text(formData, "digest"));
  if (!digest.success) return { ok: false, error: INVALID_INPUT };
  const upload = await readUpload(formData);
  if (!upload.ok) return { ok: false, error: upload.error };
  const parsed = await parseUpload(upload.value);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const outcome = await commitImport({
    parsed: parsed.parsed,
    fileName: upload.value.fileName,
    options: { skuOverrides: upload.value.skuOverrides },
    expectedDigest: digest.data,
    actorStaffUserId: session.staffUser.id,
  });

  switch (outcome.kind) {
    case "invalid":
      return { ok: false, error: outcome.message };
    case "busy":
      return { ok: false, error: BUSY_MESSAGE };
    case "stale":
    case "blocked":
    case "nothing_to_save": {
      const message = outcome.kind === "stale" ? STALE_PREVIEW_MESSAGE : outcome.kind === "blocked" ? outcome.blockers.join(" ") : NOTHING_TO_SAVE_MESSAGE;
      return { ok: true, data: { kind: "not_saved", reason: outcome.kind, message, preview: toImportPreview(parsed.parsed, outcome.plan, { canViewProfit }) } };
    }
    case "committed": {
      // Orders, Packing, stock and Ringkasan all show imported orders.
      revalidateAdmin("/import", "/orders", "/packing", "/stock");
      revalidateOverview();
      const storefront = await revalidateStorefrontForSkus(outcome.stockSkus);
      return {
        ok: true,
        data: { kind: "committed", batchId: outcome.batchId, created: outcome.created, updated: outcome.updated, reviewCount: outcome.reviewCount, storefrontOk: storefront.ok },
      };
    }
  }
}

const searchSchema = z.string().max(100);

/** The "Cocokkan ke varian" picker's search. */
export async function searchMatchVariantsAction(q: string): Promise<MatchVariantOption[]> {
  await requirePermission("orders.import");
  const parsed = searchSchema.safeParse(q);
  if (!parsed.success) return [];
  return searchMatchVariants(parsed.data);
}

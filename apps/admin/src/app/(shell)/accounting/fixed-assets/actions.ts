"use server";

import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import {
  createFixedAsset,
  disposeFixedAsset,
  updateCapitalizationThreshold,
  updateFixedAsset,
  updateFixedAssetGroup,
  UUID_PATTERN,
  voidFixedAsset,
} from "@/lib/accounting/fixed-assets";
import { FIXED_ASSET_MESSAGES } from "@/lib/accounting/fixed-asset-input";

// Aset tetap (D-19, Session 11): accounting.view + accounting.manage (plan §7), checked here on the
// server for every call. Each write is audited in lib/accounting/fixed-assets.ts; the journals follow
// on the next posting run.

const KEYS = ["accounting.view", "accounting.manage"] as const;
const INVALID_INPUT = "Input tidak valid.";
const text = (max: number) => z.string({ error: INVALID_INPUT }).max(max, INVALID_INPUT);

const assetSchema = z.object(
  {
    name: text(500),
    groupCode: text(40),
    acquisitionDate: text(20),
    cost: text(40),
    assetAccountCode: text(20),
    accumulatedAccountCode: text(20),
    fundingAccountCode: text(20),
    note: text(2000).nullable().optional(),
  },
  { error: INVALID_INPUT },
);

const disposalSchema = z.object({ disposedOn: text(20), proceeds: text(40), cashAccountCode: text(20) }, { error: INVALID_INPUT });

function validationError(error: z.ZodError): ActionResult<never> {
  const issue = error.issues[0];
  const message = issue?.message ?? INVALID_INPUT;
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  return { ok: false, error: message, fieldErrors: field ? { [field]: message } : undefined };
}

const badId = (id: unknown): boolean => typeof id !== "string" || !UUID_PATTERN.test(id);

export async function createFixedAssetAction(input: z.input<typeof assetSchema>): Promise<ActionResult<{ id: string }>> {
  const session = await requireAllPermissions(KEYS);
  const parsed = assetSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const created = await createFixedAsset(parsed.data, session.staffUser.id);
    revalidateAdmin("/accounting");
    return { id: created.id };
  });
}

export async function updateFixedAssetAction(id: string, input: z.input<typeof assetSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (badId(id)) return { ok: false, error: FIXED_ASSET_MESSAGES.notFound };
  const parsed = assetSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await updateFixedAsset(id, parsed.data, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}

export async function disposeFixedAssetAction(id: string, input: z.input<typeof disposalSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (badId(id)) return { ok: false, error: FIXED_ASSET_MESSAGES.notFound };
  const parsed = disposalSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await disposeFixedAsset(id, parsed.data, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}

export async function voidFixedAssetAction(id: string, input: { reason: string }): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (badId(id)) return { ok: false, error: FIXED_ASSET_MESSAGES.notFound };
  const parsed = z.object({ reason: text(1000) }).safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await voidFixedAsset(id, parsed.data.reason, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}

export async function updateFixedAssetGroupAction(code: string, input: { label: string; usefulLifeMonths: string }): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(code)) return { ok: false, error: FIXED_ASSET_MESSAGES.group };
  const parsed = z.object({ label: text(200), usefulLifeMonths: text(20) }).safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await updateFixedAssetGroup(code, parsed.data, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}

export async function updateCapitalizationThresholdAction(input: { capitalizationThreshold: string }): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  const parsed = z.object({ capitalizationThreshold: text(40) }).safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await updateCapitalizationThreshold(parsed.data.capitalizationThreshold, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}

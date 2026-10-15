"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as homepage from "@/lib/content/homepage";
import {
  featureBlockContentSchema,
  heroContentSchema,
  homepageSectionVisibilitySchema,
  productGridContentSchema,
  whyAmmariContentSchema,
} from "@/lib/content/homepage-schemas";

// ---------- Homepage section drafts + publish (docs/plans/storefront-cms.md, session 4) ----------
//
// Every action here is gated by `content.manage` — same permission as the product form's
// Storefront section and /content/size-charts, never a role-name check (CLAUDE.md's dynamic
// RBAC rule). Zod shape validation happens HERE (a bad shape becomes a friendly top-level error);
// business-rule checks that need the database (does a referenced product still resolve to
// something published) happen in @/lib/content/homepage, surfaced via thrown
// FieldError/ActionError -> runAction.

const heroInputSchema = homepageSectionVisibilitySchema.extend({ content: heroContentSchema });
const productGridInputSchema = homepageSectionVisibilitySchema.extend({ content: productGridContentSchema });
const featureBlockInputSchema = homepageSectionVisibilitySchema.extend({ content: featureBlockContentSchema });
const whyAmmariInputSchema = homepageSectionVisibilitySchema.extend({ content: whyAmmariContentSchema });

export async function saveHeroDraftAction(input: z.input<typeof heroInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = heroInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveHeroDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

export async function saveProductGridDraftAction(input: z.input<typeof productGridInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = productGridInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveProductGridDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

export async function saveFeatureBlockDraftAction(input: z.input<typeof featureBlockInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = featureBlockInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveFeatureBlockDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

export async function saveWhyAmmariDraftAction(input: z.input<typeof whyAmmariInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = whyAmmariInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveWhyAmmariDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

const sectionKeySchema = z.enum(["hero", "product_grid", "feature_block", "why_ammari"]);

export async function setHomepageSectionVisibilityAction(key: string, isVisible: boolean): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsedKey = sectionKeySchema.safeParse(key);
  if (!parsedKey.success) return { ok: false, error: "Bagian tidak valid." };
  return runAction(async () => {
    await homepage.setHomepageSectionDraftVisibility(parsedKey.data, isVisible, session.staffUser.id);
    return undefined;
  });
}

export async function publishHomepageAction(): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  return runAction(async () => {
    await homepage.publishHomepageSections(session.staffUser.id);
    return undefined;
  });
}

export async function discardHomepageDraftAction(): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  return runAction(async () => {
    await homepage.discardHomepageDraft(session.staffUser.id);
    return undefined;
  });
}

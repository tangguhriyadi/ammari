"use server";

import { z } from "zod";
import { COST_COMPONENT_TYPES, COST_COMPONENT_UNITS } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { optionalMoneyString } from "@/lib/products/money-schema";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as costComponentQueries from "@/lib/production/cost-components";

const costComponentSchema = z.object({
  name: z.string().trim().min(1, "Nama komponen wajib diisi."),
  unit: z.enum(COST_COMPONENT_UNITS),
  defaultUnitPrice: optionalMoneyString.optional(),
  // Defaults to "variable" (not required by every existing caller) — matches the column's own
  // DB default, so a caller that predates this field (e.g. an older test fixture) still works.
  costType: z.enum(COST_COMPONENT_TYPES).default("variable"),
  isActive: z.boolean(),
  sortOrder: z.coerce.number().int("Urutan harus bilangan bulat.").default(0),
});

export async function createCostComponentAction(
  input: z.input<typeof costComponentSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("finance.view_profit");
  const parsed = costComponentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const component = await costComponentQueries.createCostComponent(
      {
        name: parsed.data.name,
        unit: parsed.data.unit,
        defaultUnitPrice: parsed.data.defaultUnitPrice ?? null,
        costType: parsed.data.costType,
        isActive: parsed.data.isActive,
        sortOrder: parsed.data.sortOrder,
      },
      session.staffUser.id,
    );
    return { id: component.id };
  });
}

export async function updateCostComponentAction(
  id: string,
  input: z.input<typeof costComponentSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("finance.view_profit");
  const parsed = costComponentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const component = await costComponentQueries.updateCostComponent(
      id,
      {
        name: parsed.data.name,
        unit: parsed.data.unit,
        defaultUnitPrice: parsed.data.defaultUnitPrice ?? null,
        costType: parsed.data.costType,
        isActive: parsed.data.isActive,
        sortOrder: parsed.data.sortOrder,
      },
      session.staffUser.id,
    );
    return { id: component.id };
  });
}

const setActiveSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() });

export async function setCostComponentActiveAction(input: z.input<typeof setActiveSchema>): Promise<ActionResult> {
  const session = await requirePermission("finance.view_profit");
  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await costComponentQueries.setCostComponentActive(parsed.data.id, parsed.data.isActive, session.staffUser.id);
    return undefined;
  });
}

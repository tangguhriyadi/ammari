import "server-only";
import { asc, eq } from "drizzle-orm";
import { costComponents } from "@ammari/db/schema";
import type { CostComponentType, CostComponentUnit } from "@ammari/db/schema";
import { ActionError, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";

const COST_COMPONENT_CONSTRAINT_FIELDS = {
  cost_components_name_unique: { field: "name", message: "Nama komponen ini sudah dipakai." },
};

/** The owner's full master list (active and inactive) — for the management page. The batch
 * form's picker uses listActiveCostComponents instead. Small, fixed-ish reference data; no
 * pagination (same reasoning channels/cost_assumptions don't paginate either). */
export async function listCostComponents(db: Database = defaultDb) {
  return db.select().from(costComponents).orderBy(asc(costComponents.sortOrder), asc(costComponents.name));
}

export async function listActiveCostComponents(db: Database = defaultDb) {
  return db
    .select()
    .from(costComponents)
    .where(eq(costComponents.isActive, true))
    .orderBy(asc(costComponents.sortOrder), asc(costComponents.name));
}

export async function getCostComponentById(id: string, db: Database = defaultDb) {
  const [row] = await db.select().from(costComponents).where(eq(costComponents.id, id)).limit(1);
  return row ?? null;
}

export interface CostComponentInput {
  name: string;
  unit: CostComponentUnit;
  defaultUnitPrice: number | null;
  /** "variable" (scales with the batch's pcs count) or "fixed" (one flat amount per batch) —
   * see cost_components.cost_type's own doc comment in packages/db/src/schema/catalog.ts. */
  costType: CostComponentType;
  isActive: boolean;
  sortOrder: number;
}

export async function createCostComponent(
  input: CostComponentInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    try {
      const [component] = await tx.insert(costComponents).values(input).returning();
      if (!component) throw new Error("failed to insert cost component");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create",
        entityType: "cost_component",
        entityId: component.id,
        after: component,
      });
      return component;
    } catch (error) {
      mapUniqueViolation(error, COST_COMPONENT_CONSTRAINT_FIELDS);
    }
  });
}

export async function updateCostComponent(
  id: string,
  input: CostComponentInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(costComponents).where(eq(costComponents.id, id)).limit(1);
    if (!before) throw new ActionError("Komponen biaya tidak ditemukan.");

    try {
      const [after] = await tx.update(costComponents).set(input).where(eq(costComponents.id, id)).returning();
      if (!after) throw new Error("failed to update cost component");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "cost_component", entityId: id, before, after });
      return after;
    } catch (error) {
      mapUniqueViolation(error, COST_COMPONENT_CONSTRAINT_FIELDS);
    }
  });
}

/** No hard delete, ever — "delete" in the UI always means toggling this off, same as
 * fabric_colors.is_active. The production_batch_costs FK (ON DELETE RESTRICT) is a backstop for
 * a path that doesn't exist today, not the primary guarantee. */
export async function setCostComponentActive(
  id: string,
  isActive: boolean,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(costComponents).where(eq(costComponents.id, id)).limit(1);
    if (!before) throw new ActionError("Komponen biaya tidak ditemukan.");
    const [after] = await tx.update(costComponents).set({ isActive }).where(eq(costComponents.id, id)).returning();
    if (!after) throw new Error("failed to update cost component");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: isActive ? "activate" : "deactivate",
      entityType: "cost_component",
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

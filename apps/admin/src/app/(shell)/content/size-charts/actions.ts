"use server";

import { z } from "zod";
import { CUTTING_SIZES } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as sizeChartQueries from "@/lib/content/size-charts";

const sizeChartRowSchema = z.object({
  size: z.enum(CUTTING_SIZES),
  bustCm: z.coerce.number().int("Lingkar dada harus bilangan bulat.").positive("Lingkar dada harus lebih dari 0."),
  lengthCm: z.coerce.number().int("Panjang gamis harus bilangan bulat.").positive("Panjang gamis harus lebih dari 0."),
  sleeveLengthCm: z.coerce.number().int("Panjang lengan harus bilangan bulat.").positive("Panjang lengan harus lebih dari 0."),
  heightRecommendationMinCm: z.coerce
    .number()
    .int("Tinggi badan minimum harus bilangan bulat.")
    .positive("Tinggi badan minimum harus lebih dari 0."),
  heightRecommendationMaxCm: z.coerce
    .number()
    .int("Tinggi badan maksimum harus bilangan bulat.")
    .positive("Tinggi badan maksimum harus lebih dari 0."),
});

const sizeChartSchema = z.object({
  name: z.string().trim().min(1, "Nama tabel ukuran wajib diisi."),
  // Exactly one row per CUTTING_SIZES entry — validated more specifically (which sizes, in
  // which order) by sizeChartQueries' own validateRows, so a malformed/incomplete submission
  // still gets a friendly Indonesian message rather than a raw DB CHECK violation.
  rows: z.array(sizeChartRowSchema).length(CUTTING_SIZES.length, "Size chart harus memiliki baris untuk setiap ukuran."),
});

export async function createSizeChartAction(
  input: z.input<typeof sizeChartSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("content.manage");
  const parsed = sizeChartSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const chart = await sizeChartQueries.createSizeChart(parsed.data, session.staffUser.id);
    return { id: chart.id };
  });
}

export async function updateSizeChartAction(
  id: string,
  input: z.input<typeof sizeChartSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("content.manage");
  const parsed = sizeChartSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const chart = await sizeChartQueries.updateSizeChart(id, parsed.data, session.staffUser.id);
    return { id: chart.id };
  });
}

const deleteSizeChartSchema = z.object({ id: z.string().uuid() });

export async function deleteSizeChartAction(input: z.input<typeof deleteSizeChartSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = deleteSizeChartSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await sizeChartQueries.deleteSizeChart(parsed.data.id, session.staffUser.id);
    return undefined;
  });
}

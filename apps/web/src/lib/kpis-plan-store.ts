/**
 * Freezes the validated plan of a date (KPI-07, ValidatedPlan): called in
 * the transaction of « Valider le planning » (planning/actions.ts validateDay)
 * and by the history simulation at its validation. The figures are those the
 * dashboard computes from the routes and trips at that instant
 * (lib/kpis-plan.ts), with one line per vehicle. The client is passed in:
 * nothing here is server-only.
 */
import type { Prisma } from "@prisma/client";
import { computeDayKpis, DEFAULT_KPI_OPTIONS } from "@/lib/kpis";
import { loadKpiRows, type KpiClient } from "@/lib/kpis-load";
import { encodePlanFigures, planFiguresOf, replacesFrozenPlan, vehicleFiguresOf } from "@/lib/kpis-plan";
import { fromIsoDate } from "@/lib/time";

/**
 * Writes the frozen plan of `isoDate` validated at `now` by `validatedById`,
 * unless a plan validated before that day is already frozen and `now` is on
 * the day itself (kpis-plan.ts replacesFrozenPlan). Returns whether it wrote.
 */
export async function freezeValidatedPlan(
  client: KpiClient,
  isoDate: string,
  validation: { now: Date; validatedById: string | null },
): Promise<boolean> {
  const serviceDate = fromIsoDate(isoDate);
  const existing = await client.validatedPlan.findUnique({ where: { serviceDate }, select: { validatedAt: true } });
  if (!replacesFrozenPlan(existing, isoDate, validation.now)) return false;
  const data = await loadKpiRows(client, { from: isoDate, to: isoDate });
  // Planned figures only: `today` (the date itself) does not change them.
  const day = computeDayKpis(isoDate, data, isoDate, DEFAULT_KPI_OPTIONS);
  const figures = encodePlanFigures(planFiguresOf(day, vehicleFiguresOf(isoDate, data.routes, data.trips))) as unknown as Prisma.InputJsonObject;
  const fields = { validatedAt: validation.now, validatedById: validation.validatedById, figures };
  await client.validatedPlan.upsert({ where: { serviceDate }, create: { serviceDate, ...fields }, update: fields });
  return true;
}

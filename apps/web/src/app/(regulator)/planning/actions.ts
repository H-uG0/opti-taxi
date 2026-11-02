"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadVehicleInputs, personName, resolveVehicleAvailability } from "@/lib/optimizer/build-request";
import { readRunDetails } from "@/lib/optimizer/run-details";
import {
  OPTIMIZATION_IN_PROGRESS_ERROR,
  optimizationInProgress,
  replanBlocker,
  runOptimization,
} from "@/lib/planning/run-optimization";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { formatLongDate, fromIsoDate, isIsoDate, todayIso, toIsoDate } from "@/lib/time";

export type PlanningActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; needsConfirmation?: boolean };

const dateSchema = z.string().refine((value) => isIsoDate(value));
const idSchema = z.string().trim().min(1).max(64);

const INVALID_DATE: PlanningActionResult = { ok: false, error: "Date invalide." };
const UNKNOWN_TRIP: PlanningActionResult = { ok: false, error: "Course introuvable (supprimée entre-temps ?)." };

/** Routes, trips and sharing statuses feed several pages (courses, arrivées partagées, chauffeurs…). */
function refreshPages() {
  revalidatePath("/", "layout");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** « Optimiser demain » / « Réoptimiser » : recompute every route of the date, keeping locked trips on their vehicle. */
export async function optimizeDay(date: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  const parsed = dateSchema.safeParse(date);
  if (!parsed.success) return INVALID_DATE;

  const outcome = await runOptimization(parsed.data, user.id);
  refreshPages();
  return outcome.ok ? { ok: true, message: outcome.message } : { ok: false, error: outcome.error };
}

/**
 * « Déplacer vers… » : lock the trip on another vehicle, then re-optimize the
 * rest of the day. When the optimizer cannot serve the trip with that vehicle,
 * the new plan is not saved and the previous lock is restored.
 */
export async function moveTrip(tripId: string, vehicleId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  const ids = z.object({ tripId: idSchema, vehicleId: idSchema }).safeParse({ tripId, vehicleId });
  if (!ids.success) return { ok: false, error: "Course ou véhicule invalide." };

  const trip = await db.trip.findUnique({
    where: { id: ids.data.tripId },
    select: {
      id: true,
      serviceDate: true,
      status: true,
      allowedVehicleTypes: true,
      lockedVehicleId: true,
      patient: { select: { firstName: true, lastName: true } },
    },
  });
  if (!trip) return UNKNOWN_TRIP;
  if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") {
    return { ok: false, error: "Cette course est annulée : elle ne peut pas être déplacée." };
  }
  if (trip.status === "PICKED_UP" || trip.status === "DROPPED_OFF") {
    return { ok: false, error: "Cette course est déjà commencée ou terminée." };
  }

  const isoDate = toIsoDate(trip.serviceDate);
  const blocker = await replanBlocker(isoDate);
  if (blocker) return { ok: false, error: blocker };

  const { available, skipped } = resolveVehicleAvailability(await loadVehicleInputs(db), isoDate);
  const target = available.find((v) => v.id === ids.data.vehicleId);
  if (!target) {
    const skip = skipped.find((s) => s.vehicleId === ids.data.vehicleId);
    return {
      ok: false,
      error: skip ? `${skip.label} est indisponible ce jour : ${skip.reason}.` : "Véhicule introuvable ou inactif.",
    };
  }
  if (!trip.allowedVehicleTypes.includes(target.type)) {
    const allowed = trip.allowedVehicleTypes.map((t) => VEHICLE_TYPE_SHORT[t]).join(" ou ");
    return {
      ok: false,
      error: `Véhicule non autorisé : la prescription impose ${allowed || "un autre type"}, pas ${VEHICLE_TYPE_SHORT[target.type]}.`,
    };
  }

  if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

  const who = personName(trip.patient);
  await db.trip.update({ where: { id: trip.id }, data: { lockedVehicleId: target.id } });
  const outcome = await runOptimization(isoDate, user.id, {
    move: { tripId: trip.id, vehicleId: target.id, vehicleLabel: target.label, patientName: who },
  });
  if (!outcome.ok && outcome.moveRejected) {
    // Undo the lock (unless it was changed meanwhile) so the next optimization does not keep the trip unassigned.
    if (trip.lockedVehicleId !== target.id) {
      await db.trip.updateMany({
        where: { id: trip.id, lockedVehicleId: target.id },
        data: { lockedVehicleId: trip.lockedVehicleId },
      });
    }
    refreshPages();
    return { ok: false, error: outcome.error };
  }
  refreshPages();
  if (!outcome.ok) {
    return { ok: false, error: `Course de ${who} figée sur ${target.label}, mais le planning n'a pas été recalculé : ${outcome.error}` };
  }
  return { ok: true, message: `Course de ${who} déplacée et figée sur ${target.label}. ${outcome.message}` };
}

/** « Figer » : keep the trip on the vehicle of its current route at the next optimization. */
export async function lockTrip(tripId: string): Promise<PlanningActionResult> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(tripId);
  if (!id.success) return UNKNOWN_TRIP;

  const trip = await db.trip.findUnique({
    where: { id: id.data },
    select: { id: true, status: true, route: { select: { vehicleId: true, vehicle: { select: { label: true } } } } },
  });
  if (!trip) return UNKNOWN_TRIP;
  if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") {
    return { ok: false, error: "Cette course est annulée : rien à figer." };
  }
  if (!trip.route) {
    return { ok: false, error: "Cette course n'est sur aucune tournée : utilisez « Déplacer vers… » pour la placer et la figer." };
  }
  await db.trip.update({ where: { id: trip.id }, data: { lockedVehicleId: trip.route.vehicleId } });
  refreshPages();
  return { ok: true, message: `Course figée sur ${trip.route.vehicle.label} : elle y restera à la prochaine optimisation.` };
}

/** « Défiger » : let the optimizer move the trip again. */
export async function unlockTrip(tripId: string): Promise<PlanningActionResult> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(tripId);
  if (!id.success) return UNKNOWN_TRIP;

  const trip = await db.trip.findUnique({ where: { id: id.data }, select: { id: true, lockedVehicleId: true } });
  if (!trip) return UNKNOWN_TRIP;
  if (trip.lockedVehicleId) {
    await db.trip.update({ where: { id: trip.id }, data: { lockedVehicleId: null } });
    refreshPages();
  }
  return { ok: true, message: "Course défigée : la prochaine optimisation pourra la changer de véhicule." };
}

/**
 * « Valider le planning » : every route of the date becomes VALIDATED. When
 * the plan has unassigned trips, violations or cancelled trips still on a
 * route, the regulator must confirm explicitly (`confirmed`).
 */
export async function validateDay(date: string, confirmed: boolean): Promise<PlanningActionResult> {
  await requireUser("REGULATOR");
  const parsed = dateSchema.safeParse(date);
  if (!parsed.success) return INVALID_DATE;
  const isoDate = parsed.data;
  if (isoDate < todayIso()) return { ok: false, error: `Le ${formatLongDate(isoDate)} est passé.` };
  // The running optimization would replace the routes right after their validation.
  if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

  const serviceDate = fromIsoDate(isoDate);
  const [routes, unassigned, stale, planRun] = await Promise.all([
    db.route.count({ where: { serviceDate } }),
    db.trip.count({ where: { serviceDate, status: { notIn: ["CANCELLED", "NO_SHOW"] }, routeId: null } }),
    db.trip.count({ where: { serviceDate, status: { in: ["CANCELLED", "NO_SHOW"] }, routeId: { not: null } } }),
    db.optimizationRun.findFirst({
      where: { serviceDate, status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      select: { id: true, valid: true, kpis: true },
    }),
  ]);
  if (routes === 0) return { ok: false, error: "Aucune tournée à valider : lancez d'abord l'optimisation." };

  const issues: string[] = [];
  if (unassigned > 0) issues.push(plural(unassigned, "course non affectée", "courses non affectées"));
  const details = planRun ? readRunDetails(planRun.id, planRun.kpis) : null;
  if (details && details.violations.length > 0) {
    issues.push(plural(details.violations.length, "violation de contrainte", "violations de contraintes"));
  } else if (!details && planRun?.valid === false) {
    issues.push("des violations de contraintes");
  }
  if (stale > 0) issues.push(plural(stale, "course annulée encore dans une tournée", "courses annulées encore dans une tournée"));

  if (issues.length > 0 && confirmed !== true) {
    return { ok: false, needsConfirmation: true, error: `Le planning comporte ${issues.join(", ")}. Valider quand même ?` };
  }

  await db.route.updateMany({
    where: { serviceDate, status: "PROPOSED" },
    data: { status: "VALIDATED", validatedAt: new Date() },
  });
  refreshPages();
  return { ok: true, message: `Planning du ${formatLongDate(isoDate)} validé (${plural(routes, "tournée")}).` };
}

/** « Rouvrir » : back to PROPOSED so the day can be adjusted and re-optimized. */
export async function reopenDay(date: string): Promise<PlanningActionResult> {
  await requireUser("REGULATOR");
  const parsed = dateSchema.safeParse(date);
  if (!parsed.success) return INVALID_DATE;
  const isoDate = parsed.data;
  if (isoDate < todayIso()) return { ok: false, error: `Le ${formatLongDate(isoDate)} est passé.` };
  if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

  const { count } = await db.route.updateMany({
    where: { serviceDate: fromIsoDate(isoDate), status: "VALIDATED" },
    data: { status: "PROPOSED", validatedAt: null },
  });
  if (count === 0) return { ok: false, error: "Aucune tournée validée à rouvrir ce jour." };
  refreshPages();
  return { ok: true, message: `Planning du ${formatLongDate(isoDate)} rouvert : vous pouvez l'ajuster et le réoptimiser.` };
}

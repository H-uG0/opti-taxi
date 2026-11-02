/**
 * « Déplacer vers… » checks. Pure: shared by runOptimization and its tests.
 *
 * A move locks the trip on the target vehicle and re-optimizes the day. The
 * solver may still leave a locked trip unassigned (unreachable times…): the
 * plan is then refused, so a trip served before the move is not lost.
 */
import type { BuildResult } from "@/lib/optimizer/build-request";
import type { PlanResponse } from "@/lib/optimizer/contract";

export type MoveTarget = {
  tripId: string;
  vehicleId: string;
  vehicleLabel: string;
  patientName: string;
};

function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

/** Why the move cannot be sent to the optimizer (trip left out, lock dropped), or null. */
export function moveRequestIssue(
  build: Pick<BuildResult, "request" | "excludedTrips" | "droppedLocks">,
  move: MoveTarget,
): string | null {
  const excluded = build.excludedTrips.find((t) => t.tripId === move.tripId);
  if (excluded) {
    return `Course de ${move.patientName} incomplète (${clause(excluded.reason)}) : complétez-la dans Courses avant de la déplacer.`;
  }
  const dropped = build.droppedLocks.find((l) => l.tripId === move.tripId);
  if (dropped) return `${move.vehicleLabel} ne peut pas recevoir la course de ${move.patientName} : ${clause(dropped.reason)}.`;
  const trip = build.request.trips.find((t) => t.id === move.tripId);
  if (!trip) return `La course de ${move.patientName} n'est plus à planifier (annulée entre-temps ?).`;
  if (trip.lockedVehicleId !== move.vehicleId) {
    return `La course de ${move.patientName} a été figée sur un autre véhicule entre-temps : réessayez.`;
  }
  return null;
}

/** Vehicle whose route serves the trip in the plan, or null. */
export function plannedVehicleOf(plan: Pick<PlanResponse, "routes">, tripId: string): string | null {
  return plan.routes.find((r) => r.stops.some((s) => s.tripId === tripId))?.vehicleId ?? null;
}

/** Why the computed plan does not carry out the move, or null when the trip is on the target vehicle. */
export function movePlacementIssue(
  plan: Pick<PlanResponse, "routes" | "unassigned">,
  move: MoveTarget,
  vehicleLabels: ReadonlyMap<string, string>,
): string | null {
  const servedBy = plannedVehicleOf(plan, move.tripId);
  if (servedBy === move.vehicleId) return null;
  const unchanged = "Le planning n'a pas été modifié.";
  if (servedBy) {
    const other = vehicleLabels.get(servedBy) ?? "un autre véhicule";
    return `Déplacement refusé : l'optimiseur a placé la course de ${move.patientName} sur ${other} et non sur ${move.vehicleLabel}. ${unchanged}`;
  }
  const reason = plan.unassigned.find((u) => u.tripId === move.tripId)?.reason;
  return `Déplacement refusé : ${move.vehicleLabel} ne peut pas servir la course de ${move.patientName}${reason ? ` (${clause(reason)})` : ""}. ${unchanged}`;
}

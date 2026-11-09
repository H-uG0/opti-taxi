/**
 * « Déplacer vers… » checks. Pure: shared by runOptimization and its tests.
 *
 * A move locks the trip on the target vehicle and re-optimizes the day. The
 * solver may still leave a locked trip unassigned (unreachable times…): the
 * plan is then refused, so a trip served before the move is not lost.
 *
 * A refused move is kept in OptimizationRun.error, a technical column that a
 * patient's anonymisation would not reach: its messages name the trip by its
 * id (tripRef) and the patient's name is put in when the message is shown
 * (resolveTripRefs: to the regulator at once, and on the planning page).
 */
import type { BuildResult } from "@/lib/optimizer/build-request";
import type { PlanResponse } from "@/lib/optimizer/contract";

export type MoveTarget = {
  tripId: string;
  vehicleId: string;
  vehicleLabel: string;
  /** For the message shown at once (resolveTripRefs); never stored. */
  patientName: string;
};

const TRIP_REF = /\{course:([A-Za-z0-9_-]+)\}/g;

/** A trip in a stored message: shown as « la course de <patient> » (resolveTripRefs). */
export function tripRef(tripId: string): string {
  return `{course:${tripId}}`;
}

/**
 * The message with each trip reference replaced by « la course de <patient> »
 * (`patientOf` gives the name, or null for a trip no longer known: « une
 * course »). A message starting with a reference starts with a capital.
 */
export function resolveTripRefs(text: string, patientOf: (tripId: string) => string | null): string {
  const resolved = text.replace(TRIP_REF, (_, id: string) => {
    const name = patientOf(id);
    return name ? `la course de ${name}` : "une course";
  });
  return resolved === text ? text : resolved.charAt(0).toUpperCase() + resolved.slice(1);
}

function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

/**
 * Why the move cannot be sent to the optimizer (trip left out, lock dropped),
 * or null. The trip is a tripRef: resolve it to show the message.
 */
export function moveRequestIssue(
  build: Pick<BuildResult, "request" | "excludedTrips" | "droppedLocks">,
  move: MoveTarget,
): string | null {
  const ref = tripRef(move.tripId);
  const excluded = build.excludedTrips.find((t) => t.tripId === move.tripId);
  if (excluded) {
    return `${ref} est incomplète (${clause(excluded.reason)}) : complétez-la dans Courses avant de la déplacer.`;
  }
  const dropped = build.droppedLocks.find((l) => l.tripId === move.tripId);
  if (dropped) return `${move.vehicleLabel} ne peut pas recevoir ${ref} : ${clause(dropped.reason)}.`;
  const trip = build.request.trips.find((t) => t.id === move.tripId);
  if (!trip) return `${ref} n'est plus à planifier (annulée entre-temps ?).`;
  if (trip.lockedVehicleId !== move.vehicleId) {
    return `${ref} a été figée sur un autre véhicule entre-temps : réessayez.`;
  }
  return null;
}

/** Vehicle whose route serves the trip in the plan, or null. */
export function plannedVehicleOf(plan: Pick<PlanResponse, "routes">, tripId: string): string | null {
  return plan.routes.find((r) => r.stops.some((s) => s.tripId === tripId))?.vehicleId ?? null;
}

/**
 * Why the computed plan does not carry out the move, or null when the trip is
 * on the target vehicle. Stored as the run's error: the trip is a tripRef,
 * never the patient's name.
 */
export function movePlacementIssue(
  plan: Pick<PlanResponse, "routes" | "unassigned">,
  move: Pick<MoveTarget, "tripId" | "vehicleId" | "vehicleLabel">,
  vehicleLabels: ReadonlyMap<string, string>,
): string | null {
  const servedBy = plannedVehicleOf(plan, move.tripId);
  if (servedBy === move.vehicleId) return null;
  const unchanged = "Le planning n'a pas été modifié.";
  const ref = tripRef(move.tripId);
  if (servedBy) {
    const other = vehicleLabels.get(servedBy) ?? "un autre véhicule";
    return `Déplacement refusé : l'optimiseur a placé ${ref} sur ${other} et non sur ${move.vehicleLabel}. ${unchanged}`;
  }
  const reason = plan.unassigned.find((u) => u.tripId === move.tripId)?.reason;
  const why = reason ? ` (${clause(reason)})` : "";
  return `Déplacement refusé : ${move.vehicleLabel} ne peut pas servir ${ref}${why}. ${unchanged}`;
}

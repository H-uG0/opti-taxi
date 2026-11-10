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
import type { TripDirection } from "@prisma/client";
import type { BuildResult } from "@/lib/optimizer/build-request";
import type { PlanResponse } from "@/lib/optimizer/contract";

export type MoveTarget = {
  tripId: string;
  vehicleId: string;
  vehicleLabel: string;
  /** For the message shown at once (resolveTripRefs); never stored. */
  patientName: string;
  /** Leg of the trip, for the message shown at once (« l'aller de … »). */
  direction?: TripDirection;
  /**
   * The trip's lock before moveTrip set it on the vehicle (null: none). Absent
   * when the trip already was locked there: nothing to undo or to record.
   */
  previousLock?: string | null;
};

/** A trip as a message names it: the patient, and the leg when known. */
export type TripName = { patient: string; direction: TripDirection | null };

const TRIP_REF = /\{course:([A-Za-z0-9_-]+)\}/g;

/** A trip in a stored message: shown as « la course de <patient> » (resolveTripRefs). */
export function tripRef(tripId: string): string {
  return `{course:${tripId}}`;
}

/** The trips a message refers to, once each, in order. */
export function tripRefIds(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(TRIP_REF), (match) => match[1] ?? ""))].filter(Boolean);
}

/** « l'aller de Jeanne Martin », « le retour de … », « la course de … » (leg unknown). */
function tripPhrase(name: string | TripName): string {
  if (typeof name === "string") return `la course de ${name}`;
  if (name.direction === "OUTBOUND") return `l'aller de ${name.patient}`;
  if (name.direction === "RETURN") return `le retour de ${name.patient}`;
  return `la course de ${name.patient}`;
}

/**
 * The message with each trip reference replaced by « la course de <patient> »,
 * or « l'aller / le retour de <patient> » when `patientOf` gives the leg
 * (null for a trip no longer known: « une course »). A message starting with
 * a reference starts with a capital.
 */
export function resolveTripRefs(text: string, patientOf: (tripId: string) => string | TripName | null): string {
  const resolved = text.replace(TRIP_REF, (_, id: string) => {
    const name = patientOf(id);
    return name ? tripPhrase(name) : "une course";
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
    return `${ref} est incomplète (${clause(excluded.reason)})\u00a0: complétez-la dans Courses avant de la déplacer.`;
  }
  const dropped = build.droppedLocks.find((l) => l.tripId === move.tripId);
  if (dropped) return `${move.vehicleLabel} ne peut pas recevoir ${ref}\u00a0: ${clause(dropped.reason)}.`;
  const trip = build.request.trips.find((t) => t.id === move.tripId);
  if (!trip) return `${ref} n'est plus à planifier (annulée entre-temps\u202f?).`;
  if (trip.lockedVehicleId !== move.vehicleId) {
    return `${ref} a été figée sur un autre véhicule entre-temps\u00a0: réessayez.`;
  }
  return null;
}

/**
 * Start of the message of a move refused (the planning unchanged): the
 * action's answer says it, the run banner does not repeat it.
 */
export const MOVE_REFUSED_PREFIX = "Déplacement refusé";

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
    return `${MOVE_REFUSED_PREFIX}\u00a0: l'optimiseur a placé ${ref} sur ${other} et non sur ${move.vehicleLabel}. ${unchanged}`;
  }
  const reason = plan.unassigned.find((u) => u.tripId === move.tripId)?.reason;
  const why = reason ? ` (${clause(reason)})` : "";
  return `${MOVE_REFUSED_PREFIX}\u00a0: ${move.vehicleLabel} ne peut pas servir ${ref}${why}. ${unchanged}`;
}

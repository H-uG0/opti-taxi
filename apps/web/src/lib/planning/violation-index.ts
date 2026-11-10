/**
 * Violations of the plan by trip and by vehicle, for the marks of the
 * timeline (a badge on the vehicle's row, a shape on the trip's block) and of
 * the map. A trip's violation counts for the vehicle that carries it. Pure.
 */
import type { ViolationView } from "./types";

export type ViolationIndex = {
  byTrip: ReadonlyMap<string, ViolationView[]>;
  /** Violations of the vehicle itself (shift, break…) and of the trips on its route. */
  byVehicle: ReadonlyMap<string, ViolationView[]>;
};

export const NO_VIOLATIONS: ViolationIndex = { byTrip: new Map(), byVehicle: new Map() };

export function indexViolations(
  violations: readonly ViolationView[],
  trips: Readonly<Record<string, { vehicleId: string | null }>>,
): ViolationIndex {
  const byTrip = new Map<string, ViolationView[]>();
  const byVehicle = new Map<string, ViolationView[]>();
  const push = (map: Map<string, ViolationView[]>, key: string, v: ViolationView) => {
    const list = map.get(key);
    if (list) list.push(v);
    else map.set(key, [v]);
  };
  for (const v of violations) {
    if (v.tripId) push(byTrip, v.tripId, v);
    const vehicleId = v.vehicleId ?? (v.tripId ? (trips[v.tripId]?.vehicleId ?? null) : null);
    if (vehicleId) push(byVehicle, vehicleId, v);
  }
  return { byTrip, byVehicle };
}

/** « Hors fenêtre horaire, Pause manquante » — distinct labels, in order. */
export function violationLabels(violations: readonly ViolationView[]): string {
  return [...new Set(violations.map((v) => v.label))].join(", ");
}

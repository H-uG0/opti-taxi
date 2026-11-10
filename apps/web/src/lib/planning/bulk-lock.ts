/**
 * « Figer » and « Défiger » in bulk (UX-07): the route of a vehicle, the routes
 * of a depot or the whole day, in one action and one audit event. Pure: which
 * trips change, and what the regulator is told. The server action
 * (planning/actions.ts lockRoutes / unlockRoutes) loads and writes.
 */
import type { TripStatus } from "@prisma/client";

export type LockScope = { kind: "route"; vehicleId: string } | { kind: "depot"; depotId: string } | { kind: "day" };

export type ScopeTrip = {
  id: string;
  status: TripStatus;
  lockedVehicleId: string | null;
  /** Vehicle of the route the trip is in, null when unassigned. */
  routeVehicleId: string | null;
  /** A « recours exceptionnel » to an ambulance holds only while the trip stays locked on it (TAR-03). */
  exceptionalAmbulance: boolean;
};

const INACTIVE: readonly TripStatus[] = ["CANCELLED", "NO_SHOW"];

export type LockPlan = {
  /** Trips to lock, by the vehicle of their route. */
  byVehicle: Map<string, string[]>;
  count: number;
  /** Trips of the scope's routes locked on another vehicle: left as they are (the regulator chose that vehicle). */
  lockedElsewhere: number;
};

/**
 * « Figer » a scope: every active trip of its routes not locked yet is locked
 * on the vehicle of its route. A trip already locked (here or on another
 * vehicle) keeps its lock.
 */
export function tripsToLock(trips: readonly ScopeTrip[], inScope: (vehicleId: string) => boolean): LockPlan {
  const byVehicle = new Map<string, string[]>();
  let count = 0;
  let lockedElsewhere = 0;
  for (const trip of trips) {
    if (!trip.routeVehicleId || !inScope(trip.routeVehicleId) || INACTIVE.includes(trip.status)) continue;
    if (trip.lockedVehicleId !== null) {
      if (trip.lockedVehicleId !== trip.routeVehicleId) lockedElsewhere += 1;
      continue;
    }
    const list = byVehicle.get(trip.routeVehicleId);
    if (list) list.push(trip.id);
    else byVehicle.set(trip.routeVehicleId, [trip.id]);
    count += 1;
  }
  return { byVehicle, count, lockedElsewhere };
}

export type UnlockPlan = {
  ids: string[];
  /** Exceptional ambulances kept: « Défiger » withdraws one, so only its own panel does it. */
  keptExceptional: number;
};

/**
 * « Défiger » a scope: every lock on one of its vehicles, or on a trip of one
 * of its routes, is removed, except the exceptional ambulances.
 */
export function tripsToUnlock(trips: readonly ScopeTrip[], inScope: (vehicleId: string) => boolean): UnlockPlan {
  const ids: string[] = [];
  let keptExceptional = 0;
  for (const trip of trips) {
    if (trip.lockedVehicleId === null) continue;
    const concerned = inScope(trip.lockedVehicleId) || (trip.routeVehicleId !== null && inScope(trip.routeVehicleId));
    if (!concerned) continue;
    if (trip.exceptionalAmbulance) keptExceptional += 1;
    else ids.push(trip.id);
  }
  return { ids, keptExceptional };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** « la tournée de Taxi 1 », « les tournées du dépôt de Gap », « toutes les tournées du jour ». */
export function scopeText(scope: LockScope, name: string | null): string {
  if (scope.kind === "route") return `la tournée de ${name ?? "ce véhicule"}`;
  if (scope.kind === "depot") return `les tournées du dépôt ${name ?? ""}`.trimEnd();
  return "toutes les tournées du jour";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function lockMessage(scope: LockScope, name: string | null, locked: number, plan: Pick<LockPlan, "lockedElsewhere">): string {
  const what = scopeText(scope, name);
  const parts = [
    locked > 0
      ? `${capitalized(what)} : ${plural(locked, "course figée", "courses figées")}, ${locked > 1 ? "elles resteront" : "elle restera"} sur ${locked > 1 ? "leur" : "son"} véhicule à la prochaine optimisation.`
      : `Rien à figer dans ${what} : ses courses sont déjà figées.`,
  ];
  if (plan.lockedElsewhere > 0) {
    parts.push(
      `${plural(plan.lockedElsewhere, "course figée", "courses figées")} sur un autre véhicule ${plan.lockedElsewhere > 1 ? "gardent" : "garde"} ce verrou.`,
    );
  }
  return parts.join(" ");
}

export function unlockMessage(scope: LockScope, name: string | null, unlocked: number, plan: Pick<UnlockPlan, "keptExceptional">): string {
  const what = scopeText(scope, name);
  const parts = [
    unlocked > 0
      ? `${capitalized(what)} : ${plural(unlocked, "course défigée", "courses défigées")}, la prochaine optimisation pourra ${unlocked > 1 ? "les" : "la"} changer de véhicule.`
      : `Rien à défiger dans ${what}.`,
  ];
  if (plan.keptExceptional > 0) {
    parts.push(
      `${plural(plan.keptExceptional, "recours exceptionnel", "recours exceptionnels")} à une ambulance ${plan.keptExceptional > 1 ? "restent figés" : "reste figé"} : défigez-${plan.keptExceptional > 1 ? "les" : "le"} depuis la course.`,
    );
  }
  return parts.join(" ");
}

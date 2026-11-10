/**
 * Équipages at fleet scale (120 vehicles, 150 people): the filter of the
 * page (depot, « à traiter seulement »), kept in the URL with the planning's
 * parameter names (?depot=…&etat=a-traiter), and the summary of each depot
 * (seats, filled, missing, free people), computed from the form as it stands
 * so it follows the unsaved changes. Pure module.
 */
import type { VehicleType } from "@prisma/client";
import { compareLabels } from "@/lib/fleet/order";
import type { SearchParams } from "@/lib/list-filters";
import type { CrewIssue, Seat } from "@/lib/staff/day-crews";
import type { Assignments, CrewPersonOption } from "./person-options";
import { PARK_VALUE } from "./schema";

/** The planning's state « À traiter » (lib/planning/filter.ts), the same word in the address. */
export const TO_HANDLE = "a-traiter";

export type CrewFilter = { depot: string | null; toHandle: boolean };

function first(params: SearchParams | URLSearchParams, key: string): string {
  const raw = params instanceof URLSearchParams ? params.get(key) : params[key];
  return ((Array.isArray(raw) ? raw[0] : raw) ?? "").trim();
}

/** ?depot=<id> (the first one of a planning link « d1,d2 ») and ?etat=a-traiter. */
export function parseCrewFilter(params: SearchParams | URLSearchParams, depotIds: ReadonlySet<string>): CrewFilter {
  const depot = first(params, "depot").split(",")[0]?.trim() ?? "";
  return {
    depot: depotIds.has(depot) ? depot : null,
    toHandle: first(params, "etat").split(",").includes(TO_HANDLE),
  };
}

export type SummaryRow = {
  vehicleId: string;
  depotId: string;
  depotName: string;
  type: VehicleType;
  unavailable: boolean;
  issues: readonly CrewIssue[];
  proposedSeats: readonly Seat[];
};

/**
 * A row to look at: a blocking problem (red), a replacement proposed by the
 * tool, a change since the routes were computed or an overdue deadline
 * (`flagged`: the planning's « À traiter »), or an unsaved change. A vehicle
 * out of service has nothing to handle here.
 */
export function needsAttention(row: SummaryRow, flagged: ReadonlySet<string>, dirty: ReadonlySet<string>): boolean {
  if (dirty.has(row.vehicleId)) return true;
  if (row.unavailable) return false;
  return row.issues.some((issue) => issue.level === "error") || row.proposedSeats.length > 0 || flagged.has(row.vehicleId);
}

export type DepotSummary = {
  depotId: string;
  depotName: string;
  vehicles: number;
  /** Out of service that day. */
  unavailable: number;
  /** Kept at the depot by the regulator. */
  parked: number;
  /** Seats to fill on the vehicles that work: one per vehicle, two on an ambulance. */
  seats: number;
  filled: number;
  missing: number;
  /** People of the depot who work that day, available, on no vehicle of the form. */
  free: CrewPersonOption[];
};

export function depotSummaries(
  rows: readonly SummaryRow[],
  values: ReadonlyMap<string, { driver: string; mate: string }>,
  people: readonly CrewPersonOption[],
  assignments: Assignments,
): DepotSummary[] {
  const byDepot = new Map<string, DepotSummary>();
  for (const row of rows) {
    let summary = byDepot.get(row.depotId);
    if (!summary) {
      summary = { depotId: row.depotId, depotName: row.depotName, vehicles: 0, unavailable: 0, parked: 0, seats: 0, filled: 0, missing: 0, free: [] };
      byDepot.set(row.depotId, summary);
    }
    summary.vehicles += 1;
    if (row.unavailable) {
      summary.unavailable += 1;
      continue;
    }
    const value = values.get(row.vehicleId) ?? { driver: "", mate: "" };
    if (value.driver === PARK_VALUE) {
      summary.parked += 1;
      continue;
    }
    const ambulance = row.type === "AMBULANCE";
    summary.seats += ambulance ? 2 : 1;
    summary.filled += (value.driver ? 1 : 0) + (ambulance && value.mate ? 1 : 0);
  }
  for (const summary of byDepot.values()) {
    summary.missing = summary.seats - summary.filled;
    summary.free = people.filter(
      (p) => p.depotId === summary.depotId && p.active && p.absence === null && p.worksThatDay && !assignments.has(p.id),
    );
  }
  return [...byDepot.values()].sort((a, b) => compareLabels(a.depotName, b.depotName));
}

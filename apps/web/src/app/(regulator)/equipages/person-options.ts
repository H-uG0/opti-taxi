/**
 * Choices of a seat on the Équipages page, grouped the way a regulator looks
 * for a replacement: free and qualified people of the vehicle's depot, then
 * of the other depots with the distance, then the people already on another
 * vehicle (with its label), then those who cannot take it that day
 * (absent, deactivated), shown but not selectable; the people not qualified
 * for the seat only show once a name is typed (why is X not offered?).
 * Pure module.
 */
import type { VehicleType } from "@prisma/client";
import type { SearchSelectGroup, SearchSelectOption } from "@/components/ui/search-select";
import { compareLabels } from "@/lib/fleet/order";
import type { Seat } from "@/lib/staff/day-crews";
import { PARK_VALUE } from "./schema";

export type CrewPersonOption = {
  id: string;
  /** « DUPONT Marc ». */
  name: string;
  active: boolean;
  depotId: string | null;
  /** "absence du … au …", or null when not absent that day. */
  absence: string | null;
  worksThatDay: boolean;
  canDrive: Record<VehicleType, boolean>;
  canCrew: boolean;
  /** Short qualification names (« Carte taxi, DEA »). */
  qualifications: string;
};

export type SeatContext = {
  vehicleId: string;
  type: VehicleType;
  depotId: string;
  seat: Seat;
  /** The value of the other seat of the row (an ambulance's driver for its crew mate seat), "" if none. */
  otherSeatValue: string;
};

export type DepotInfo = {
  names: ReadonlyMap<string, string>;
  /** Straight-line km between depots, by depot id then depot id. */
  km: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

/** Where a person is, from the crews shown in the form (unsaved changes included): person id → vehicle label. */
export type Assignments = ReadonlyMap<string, { vehicleId: string; label: string }>;

function depotText(person: CrewPersonOption, seat: SeatContext, depots: DepotInfo): { text: string; km: number } {
  if (!person.depotId) return { text: "sans dépôt", km: Number.POSITIVE_INFINITY };
  const name = depots.names.get(person.depotId) ?? "autre dépôt";
  if (person.depotId === seat.depotId) return { text: name, km: 0 };
  const km = depots.km.get(seat.depotId)?.get(person.depotId);
  return km === undefined ? { text: name, km: Number.POSITIVE_INFINITY } : { text: `${name}, ${Math.round(km)} km`, km };
}

const NOT_QUALIFIED = "non qualifié pour ce poste";

/** Why a person cannot take the seat, or null. */
export function unavailableReason(person: CrewPersonOption, seat: SeatContext): string | null {
  if (!person.active) return "désactivé";
  if (person.absence) return person.absence;
  if (!(seat.seat === "driver" ? person.canDrive[seat.type] : person.canCrew)) return NOT_QUALIFIED;
  if (person.id === seat.otherSeatValue) return "déjà à l'autre poste de ce véhicule";
  return null;
}

/**
 * The groups of choices of a seat. `special`: the choices that are not a
 * person (« — Aucun chauffeur — », « Laisser au dépôt ce jour »), first.
 */
export function seatOptions(
  people: readonly CrewPersonOption[],
  seat: SeatContext,
  assignments: Assignments,
  depots: DepotInfo,
  special: readonly SearchSelectOption[],
): (SearchSelectOption | SearchSelectGroup)[] {
  const own: { option: SearchSelectOption; rank: number; name: string }[] = [];
  const others: { option: SearchSelectOption; km: number; name: string }[] = [];
  const taken: { option: SearchSelectOption; name: string }[] = [];
  const out: { option: SearchSelectOption; name: string }[] = [];
  const unqualified: { option: SearchSelectOption; name: string }[] = [];
  for (const person of people) {
    const why = unavailableReason(person, seat);
    const where = depotText(person, seat, depots);
    const unusual = person.worksThatDay ? "" : " · hors de ses jours habituels";
    if (why) {
      const entry = { option: { value: person.id, label: person.name, hint: why, disabled: true }, name: person.name };
      (why === NOT_QUALIFIED ? unqualified : out).push(entry);
      continue;
    }
    const on = assignments.get(person.id);
    if (on && on.vehicleId !== seat.vehicleId) {
      taken.push({ option: { value: person.id, label: person.name, hint: `sur ${on.label} · ${where.text}${unusual}` }, name: person.name });
    } else if (person.depotId === seat.depotId) {
      const hint = `${person.qualifications}${unusual}`;
      own.push({ option: { value: person.id, label: person.name, hint }, rank: person.worksThatDay ? 0 : 1, name: person.name });
    } else {
      others.push({ option: { value: person.id, label: person.name, hint: `${where.text} · ${person.qualifications}${unusual}` }, km: where.km, name: person.name });
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => compareLabels(a.name, b.name);
  const ownDepot = depots.names.get(seat.depotId) ?? "du véhicule";
  const groups: SearchSelectGroup[] = [
    { label: `Libres — dépôt ${ownDepot}`, options: own.sort((a, b) => a.rank - b.rank || byName(a, b)).map((e) => e.option) },
    { label: "Libres — autres dépôts", options: others.sort((a, b) => a.km - b.km || byName(a, b)).map((e) => e.option) },
    { label: "Déjà sur un autre véhicule", options: taken.sort(byName).map((e) => e.option) },
    { label: "Absents ou désactivés", options: out.sort(byName).map((e) => e.option) },
    { label: "Non qualifiés pour ce poste", options: unqualified.sort(byName).map((e) => e.option), searchOnly: true },
  ];
  return [...special, ...groups.filter((g) => g.options.length > 0)];
}

/** Who is on which vehicle in the form as it stands (the first seat found wins, in display order). */
export function assignmentsOf(
  rows: readonly { vehicleId: string; label: string; unavailable: boolean }[],
  values: ReadonlyMap<string, { driver: string; mate: string }>,
): Map<string, { vehicleId: string; label: string }> {
  const found = new Map<string, { vehicleId: string; label: string }>();
  for (const row of rows) {
    if (row.unavailable) continue;
    const value = values.get(row.vehicleId);
    // Left at the depot: nobody on board, the crew mate's choice is ignored.
    if (!value || value.driver === PARK_VALUE) continue;
    for (const id of [value.driver, value.mate]) {
      if (id && !found.has(id)) found.set(id, { vehicleId: row.vehicleId, label: row.label });
    }
  }
  return found;
}

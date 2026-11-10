/**
 * Crew form of a date (Équipages page): reading the submitted crews, the rows
 * the regulator changed, the concurrency check on the fixed crews and the
 * problems that block saving them. Pure module (unit-tested).
 *
 * Only the changed rows are fixed (DayCrew), or the row whose proposal the
 * regulator fixes as shown (« Fixer cette proposition »): an untouched row
 * stays a proposal and keeps following the absences. Each row carries the
 * crew it showed (`was-…`) and the version of its fixed crew (`version:…`,
 * the DayCrew.updatedAt shown, empty for a proposal): a row changed by a
 * colleague since the page was shown is refused, never overwritten. A change
 * that takes a person from a fixed crew the regulator did not change is
 * refused on the changed row, whatever the display order.
 */
import type { VehicleType } from "@prisma/client";
import { valueOf, type FieldErrors, type FormValues } from "@/lib/forms";
import {
  absenceOn,
  planningAbsenceText,
  staffName,
  type DatedAbsence,
  type DayCrewPlan,
  type DayCrewView,
  type SavedCrew,
  type StaffPerson,
} from "@/lib/staff/day-crews";
import { formatDateTime } from "@/lib/time";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const driverField = (vehicleId: string) => `driver:${vehicleId}`;
export const crewMateField = (vehicleId: string) => `mate:${vehicleId}`;
/** The crew the row showed: a row is changed when its selects differ from it. */
export const shownDriverField = (vehicleId: string) => `was-driver:${vehicleId}`;
export const shownCrewMateField = (vehicleId: string) => `was-mate:${vehicleId}`;
/** DayCrew.updatedAt of the fixed crew shown (ISO), "" for a proposal. */
export const versionField = (vehicleId: string) => `version:${vehicleId}`;

/**
 * Driver select value « Laisser au dépôt ce jour »: nobody on purpose, a
 * change even when the row already shows nobody (« Aucun disponible »). Not
 * an id (the ids never hold "@").
 */
export const PARK_VALUE = "@depot";

/** « Revenir à la proposition » of one row: the submit button's intent. */
export const UNFIX_INTENT = "unfix:";
/** « Fixer cette proposition » of one row: its crew as shown becomes a fixed crew. */
export const FIX_INTENT = "fix:";

function intentVehicle(intent: string, prefix: string): string | null {
  if (!intent.startsWith(prefix)) return null;
  const id = intent.slice(prefix.length);
  return ID.test(id) ? id : null;
}

export function unfixIntentVehicle(intent: string): string | null {
  return intentVehicle(intent, UNFIX_INTENT);
}

export function fixIntentVehicle(intent: string): string | null {
  return intentVehicle(intent, FIX_INTENT);
}

/** A row of the form as submitted: the crew chosen, the crew shown and the version shown. */
export type CrewFormRow = SavedCrew & {
  /** « Laisser au dépôt ce jour » chosen (driver and crew mate null). */
  park: boolean;
  shown: { driverId: string | null; crewMateId: string | null; park: boolean };
  /** DayCrew.updatedAt shown (ISO), "" when the row was a proposal. */
  version: string;
};

/**
 * The crew of every vehicle as submitted: an empty select means nobody. A
 * malformed id or version is reported on its field. Only an ambulance has a
 * crew mate.
 */
export function readCrewForm(
  values: FormValues,
  vehicles: readonly { id: string; type: VehicleType }[],
): { rows: CrewFormRow[]; errors: FieldErrors } {
  const rows: CrewFormRow[] = [];
  const errors: FieldErrors = {};
  const read = (field: string, reportOn = field): string | null => {
    const raw = valueOf(values, field).trim();
    if (raw === "") return null;
    if (!ID.test(raw)) {
      errors[reportOn] = "Personne inconnue : rechargez la page.";
      return null;
    }
    return raw;
  };
  const isPark = (field: string) => valueOf(values, field).trim() === PARK_VALUE;
  for (const vehicle of vehicles) {
    const ambulance = vehicle.type === "AMBULANCE";
    const park = isPark(driverField(vehicle.id));
    const shownPark = isPark(shownDriverField(vehicle.id));
    const driverId = park ? null : read(driverField(vehicle.id));
    const crewMateId = ambulance && !park ? read(crewMateField(vehicle.id)) : null;
    const shown = {
      driverId: shownPark ? null : read(shownDriverField(vehicle.id), driverField(vehicle.id)),
      crewMateId: ambulance && !shownPark ? read(shownCrewMateField(vehicle.id), crewMateField(vehicle.id)) : null,
      park: shownPark,
    };
    const version = valueOf(values, versionField(vehicle.id)).trim();
    if (version !== "" && !VERSION.test(version)) errors[driverField(vehicle.id)] = "Page périmée : rechargez la page.";
    rows.push({ vehicleId: vehicle.id, driverId, crewMateId, park, shown, version });
  }
  return { rows, errors };
}

/** Rows whose crew differs from the one shown (or left at the depot on purpose): the only ones written. */
export function changedRows(rows: readonly CrewFormRow[]): CrewFormRow[] {
  return rows.filter(
    (row) => row.park !== row.shown.park || row.driverId !== row.shown.driverId || row.crewMateId !== row.shown.crewMateId,
  );
}

/** « Fixer cette proposition »: the row as it was shown, written like a change (same checks, same version). */
export function asShown(row: CrewFormRow): CrewFormRow {
  return { ...row, driverId: row.shown.driverId, crewMateId: row.shown.crewMateId, park: row.shown.park };
}

/** The fixed crews a page showed, by their version (`version:…` fields), for « Revenir aux propositions ». */
export function shownVersions(values: FormValues, vehicleIds: readonly string[]): { vehicleId: string; updatedAt: Date }[] {
  return vehicleIds.flatMap((vehicleId) => {
    const version = valueOf(values, versionField(vehicleId)).trim();
    return VERSION.test(version) ? [{ vehicleId, updatedAt: new Date(version) }] : [];
  });
}

/** The fixed crew of a vehicle as it is now in the database. */
export type CurrentCrew = { updatedAt: Date; updatedBy: string | null };

/** "Modifié par Marie Dupont le 09/11 à 14:32 entre-temps" (or without the name when unknown). */
export function changedMeanwhileText(current: CurrentCrew | undefined): string {
  if (!current) return "Remis à la proposition automatique par un collègue entre-temps : rechargez la page.";
  const by = current.updatedBy ? ` par ${current.updatedBy}` : "";
  return `Modifié${by} le ${formatDateTime(current.updatedAt.toISOString())} entre-temps : rechargez la page pour voir son choix.`;
}

/**
 * Changed rows a colleague changed too since the page was shown: their fixed
 * crew is not the version the row showed (fixed, changed or removed since).
 */
export function concurrentChangeErrors(
  rows: readonly CrewFormRow[],
  current: ReadonlyMap<string, CurrentCrew>,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const row of rows) {
    const now = current.get(row.vehicleId);
    const nowVersion = now ? now.updatedAt.toISOString() : "";
    if (nowVersion !== row.version) errors[driverField(row.vehicleId)] = changedMeanwhileText(now);
  }
  return errors;
}

/**
 * People the regulator puts on a changed row while they cannot work that day
 * (deactivated, absent): refused on their field. Once fixed, a person who
 * becomes unavailable later gets a replacement proposed instead.
 */
export function unavailableChoiceErrors(
  rows: readonly CrewFormRow[],
  people: ReadonlyMap<string, Pick<StaffPerson, "firstName" | "lastName" | "active">>,
  absences: readonly DatedAbsence[],
  date: string,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const row of rows) {
    for (const [field, id] of [
      [driverField(row.vehicleId), row.driverId],
      [crewMateField(row.vehicleId), row.crewMateId],
    ] as const) {
      const person = id ? people.get(id) : undefined;
      if (!id || !person) continue;
      const absence = absenceOn(id, date, absences);
      if (!person.active) errors[field] = `${staffName(person)} est désactivé`;
      else if (absence) errors[field] = `${staffName(person)} : ${planningAbsenceText(absence).toLowerCase()}`;
    }
  }
  return errors;
}

/** The fixed crews of the date once the changed rows are applied on top of those in the database. */
export function mergeFixedCrews(saved: readonly SavedCrew[], changed: readonly CrewFormRow[]): SavedCrew[] {
  const merged = new Map(saved.map((crew) => [crew.vehicleId, crew]));
  for (const row of changed) merged.set(row.vehicleId, { vehicleId: row.vehicleId, driverId: row.driverId, crewMateId: row.crewMateId });
  return [...merged.values()];
}

/**
 * Problems that block saving: every error of the resolved crews of the
 * vehicles in `only` (the changed rows; all when absent), except a vehicle
 * left without anybody on purpose (it stays at the depot that day). A crew
 * mate without a driver gets its own message.
 */
export function crewFormErrors(plan: Pick<DayCrewPlan, "crews">, only?: ReadonlySet<string>): FieldErrors {
  const errors: FieldErrors = {};
  for (const crew of plan.crews) {
    if (only && !only.has(crew.vehicleId)) continue;
    if (crew.driverId === null && crew.crewMateId === null) continue;
    if (crew.driverId === null) errors[driverField(crew.vehicleId)] = "Choisissez aussi un chauffeur, ou retirez l'équipier.";
    for (const issue of crew.issues) {
      if (issue.level !== "error") continue;
      const field = issue.seat === "crewMate" ? crewMateField(crew.vehicleId) : driverField(crew.vehicleId);
      if (!errors[field]) errors[field] = issue.message;
    }
  }
  return errors;
}

/** People of the fixed crews the regulator did not change (seats not proposed), with their vehicle. */
function fixedPeople(plan: Pick<DayCrewPlan, "crews">, changed: ReadonlySet<string>): Map<string, string> {
  const fixed = new Map<string, string>();
  for (const crew of plan.crews) {
    if (crew.source !== "saved" || crew.unavailable || changed.has(crew.vehicleId)) continue;
    for (const [seat, id] of [
      ["driver", crew.driverId],
      ["crewMate", crew.crewMateId],
    ] as const) {
      if (id && !crew.proposedSeats.includes(seat) && !fixed.has(id)) fixed.set(id, crew.vehicleId);
    }
  }
  return fixed;
}

/**
 * Changed rows that put a person fixed on a row the regulator did not change
 * (`before`: the crews as they are now): refused on the changed row's seat.
 * The crews of the day give a person to the first vehicle in display order,
 * so without this the other fixed crew would silently lose them (and be left
 * out of the planning) when the changed row comes first.
 */
export function takenFromFixedErrors(
  changed: readonly CrewFormRow[],
  before: Pick<DayCrewPlan, "crews">,
  people: ReadonlyMap<string, Pick<StaffPerson, "firstName" | "lastName">>,
  labels: ReadonlyMap<string, string>,
): FieldErrors {
  const fixed = fixedPeople(before, new Set(changed.map((row) => row.vehicleId)));
  const errors: FieldErrors = {};
  for (const row of changed) {
    for (const [field, id] of [
      [driverField(row.vehicleId), row.driverId],
      [crewMateField(row.vehicleId), row.crewMateId],
    ] as const) {
      const vehicleId = id ? fixed.get(id) : undefined;
      if (!id || !vehicleId) continue;
      const person = people.get(id);
      const label = labels.get(vehicleId) ?? "un autre véhicule";
      errors[field] =
        `${person ? staffName(person) : "Cette personne"} fait déjà partie de l'équipage fixé de ${label} ce jour : revenez d'abord à la proposition sur ${label}, ou choisissez quelqu'un d'autre.`;
    }
  }
  return errors;
}

/**
 * Blocking problems a change makes appear on the fixed crews the regulator
 * did not change, on a seat holding a fixed person (`before` and `after`: the
 * crews without and with the change). An empty seat whose proposal moves is
 * not one: the regulator's choice wins over a proposal.
 */
export function brokenFixedCrews(
  before: Pick<DayCrewPlan, "crews">,
  after: Pick<DayCrewPlan, "crews">,
  changed: ReadonlySet<string>,
): { vehicleId: string; message: string }[] {
  const had = new Map(
    before.crews.map((crew) => [crew.vehicleId, new Set(crew.issues.filter((i) => i.level === "error").map((i) => i.message))]),
  );
  const broken: { vehicleId: string; message: string }[] = [];
  for (const crew of after.crews) {
    if (changed.has(crew.vehicleId) || crew.source !== "saved" || crew.unavailable) continue;
    for (const issue of crew.issues) {
      if (issue.level !== "error" || issue.seat === null || crew.proposedSeats.includes(issue.seat)) continue;
      if ((issue.seat === "driver" ? crew.driverId : crew.crewMateId) === null) continue;
      if (!had.get(crew.vehicleId)?.has(issue.message)) broken.push({ vehicleId: crew.vehicleId, message: issue.message });
    }
  }
  return broken;
}

/** What the « Origine » column says about a row. */
export type CrewOrigin = "fixed" | "parked" | "default" | "replacement" | "none";

export function crewOrigin(crew: Pick<DayCrewView, "source" | "parked">): CrewOrigin {
  if (crew.parked) return "parked";
  if (crew.source === "saved") return "fixed";
  return crew.source;
}

export const ORIGIN_LABELS: Record<CrewOrigin, string> = {
  fixed: "Fixé",
  parked: "Laissé au dépôt",
  default: "Attitré",
  replacement: "Remplaçant",
  none: "Aucun disponible",
};

/**
 * Crew form of a date (Équipages page): reading the submitted crews, the rows
 * the regulator changed, the concurrency check on the fixed crews and the
 * problems that block saving them. Pure module (unit-tested).
 *
 * Only the changed rows are fixed (DayCrew): an untouched row stays a
 * proposal and keeps following the absences. Each row carries the crew it
 * showed (`was-…`) and the version of its fixed crew (`version:…`, the
 * DayCrew.updatedAt shown, empty for a proposal): a row changed by a colleague
 * since the page was shown is refused, never overwritten.
 */
import type { VehicleType } from "@prisma/client";
import { formatInstant } from "@/lib/planning/format";
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

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const driverField = (vehicleId: string) => `driver:${vehicleId}`;
export const crewMateField = (vehicleId: string) => `mate:${vehicleId}`;
/** The crew the row showed: a row is changed when its selects differ from it. */
export const shownDriverField = (vehicleId: string) => `was-driver:${vehicleId}`;
export const shownCrewMateField = (vehicleId: string) => `was-mate:${vehicleId}`;
/** DayCrew.updatedAt of the fixed crew shown (ISO), "" for a proposal. */
export const versionField = (vehicleId: string) => `version:${vehicleId}`;

/** « Revenir à la proposition » of one row: the submit button's intent. */
export const UNFIX_INTENT = "unfix:";

export function unfixIntentVehicle(intent: string): string | null {
  if (!intent.startsWith(UNFIX_INTENT)) return null;
  const id = intent.slice(UNFIX_INTENT.length);
  return ID.test(id) ? id : null;
}

/** A row of the form as submitted: the crew chosen, the crew shown and the version shown. */
export type CrewFormRow = SavedCrew & {
  shown: { driverId: string | null; crewMateId: string | null };
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
  for (const vehicle of vehicles) {
    const ambulance = vehicle.type === "AMBULANCE";
    const driverId = read(driverField(vehicle.id));
    const crewMateId = ambulance ? read(crewMateField(vehicle.id)) : null;
    const shown = {
      driverId: read(shownDriverField(vehicle.id), driverField(vehicle.id)),
      crewMateId: ambulance ? read(shownCrewMateField(vehicle.id), crewMateField(vehicle.id)) : null,
    };
    const version = valueOf(values, versionField(vehicle.id)).trim();
    if (version !== "" && !VERSION.test(version)) errors[driverField(vehicle.id)] = "Page périmée : rechargez la page.";
    rows.push({ vehicleId: vehicle.id, driverId, crewMateId, shown, version });
  }
  return { rows, errors };
}

/** Rows whose crew differs from the one shown: the only ones written. */
export function changedRows(rows: readonly CrewFormRow[]): CrewFormRow[] {
  return rows.filter((row) => row.driverId !== row.shown.driverId || row.crewMateId !== row.shown.crewMateId);
}

/** The fixed crew of a vehicle as it is now in the database. */
export type CurrentCrew = { updatedAt: Date; updatedBy: string | null };

/** "Modifié par Marie Dupont le 09/11 à 14:32 entre-temps" (or without the name when unknown). */
export function changedMeanwhileText(current: CurrentCrew | undefined): string {
  if (!current) return "Remis à la proposition automatique par un collègue entre-temps : rechargez la page.";
  const by = current.updatedBy ? ` par ${current.updatedBy}` : "";
  return `Modifié${by} le ${formatInstant(current.updatedAt.toISOString())} entre-temps : rechargez la page pour voir son choix.`;
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
 * left without anybody on purpose (it stays at the depot that day).
 */
export function crewFormErrors(plan: Pick<DayCrewPlan, "crews">, only?: ReadonlySet<string>): FieldErrors {
  const errors: FieldErrors = {};
  for (const crew of plan.crews) {
    if (only && !only.has(crew.vehicleId)) continue;
    if (crew.driverId === null && crew.crewMateId === null) continue;
    for (const issue of crew.issues) {
      if (issue.level !== "error") continue;
      const field = issue.seat === "crewMate" ? crewMateField(crew.vehicleId) : driverField(crew.vehicleId);
      if (!errors[field]) errors[field] = issue.message;
    }
    if (crew.driverId === null && crew.crewMateId !== null && !errors[driverField(crew.vehicleId)]) {
      errors[driverField(crew.vehicleId)] = "Choisissez aussi un chauffeur, ou retirez l'équipier.";
    }
  }
  return errors;
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

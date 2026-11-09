/**
 * Builds the OptimizeRequest of a service date.
 *
 * Two layers:
 * - `buildOptimizeRequest` (pure): business rules deciding which vehicles can
 *   work that day, which trips are sent, which locks are kept. Unit-tested.
 * - `loadOptimizeInput` (DB): reads everything the builder needs. It receives
 *   the Prisma client as a parameter so this module has no server-only import.
 *
 * The crew of each vehicle is the crew of the day (lib/staff/day-crews.ts),
 * applied by `applyDayCrewPlan` on top of the default crews: absences,
 * replacements and the crews fixed by the regulator.
 */
import type {
  AppSettings,
  PrismaClient,
  SharingStatus,
  TariffGrid,
  TripDirection,
  TripStatus,
  VehicleType,
} from "@prisma/client";
import { isShareable } from "@/lib/domain/rules";
import { getSettings } from "@/lib/domain/settings";
import { loadTrafficZones, toContractTraffic, type TrafficInput } from "@/lib/domain/traffic";
import { tariffGaps, tariffsInForce, type TariffGap } from "@/lib/domain/tariffs";
import { complianceAlerts, COMPLIANCE_KINDS } from "@/lib/fleet/maintenance";
import type { ReplaceThresholds } from "@/lib/planning/plan-compare";
import {
  DEFAULT_CREW_RULES,
  resolveDayCrews,
  type CrewRules,
  type DayCrewInput,
  type DayCrewPlan,
  type DayCrewView,
  type StaffPerson,
} from "@/lib/staff/day-crews";
import { fromIsoDate, isoWeekday, toIsoDate, WEEKDAY_LABELS } from "@/lib/time";
import type {
  OptimizeRequest,
  OptimizerSettings,
  OptimizerTariff,
  OptimizerTrip,
  OptimizerVehicle,
} from "./contract";

const MAX_DAY_MINUTE = 2 * 24 * 60;
const MAX_CAPACITY = 8;
const VEHICLE_TYPE_ORDER: Record<VehicleType, number> = { TAXI: 0, VSL: 1, AMBULANCE: 2 };

/** Trip statuses that never reach the optimizer. */
export const EXCLUDED_TRIP_STATUSES: readonly TripStatus[] = ["CANCELLED", "NO_SHOW"];

/** Upper bound of settings.timeLimitSec in the contract (contract.ts, schemas.py). */
export const CONTRACT_MAX_TIME_LIMIT_SEC = 600;
/** Trips the solver needs about one second for to return a complete plan (measured on the seeded days). */
export const TRIPS_PER_SOLVER_SECOND = 8;
/** A RUNNING run older than its solver budget plus this margin was interrupted (server restart, crash). */
export const STALE_RUN_MARGIN_SEC = 120;

// ---------------------------------------------------------------------------
// Input shapes (subsets of the Prisma models, so tests can build them by hand)
// ---------------------------------------------------------------------------

export type DriverInput = {
  id: string;
  firstName: string;
  lastName: string;
  active: boolean;
  workDays: number[];
  shiftStartMinute: number;
  shiftEndMinute: number;
  breakWindowStartMinute: number | null;
  breakWindowEndMinute: number | null;
  breakMinutes: number;
  hourlyCost: number;
};

export type VehicleInput = {
  id: string;
  label: string;
  type: VehicleType;
  capacity: number;
  /** Start and end of the vehicle's routes. */
  depot: { lat: number; lng: number };
  department: string;
  costPerKm: number;
  active: boolean;
  /** The default driver, or the driver of the day once applyDayCrewPlan ran (`dayCrew` set). */
  defaultDriver: DriverInput | null;
  /** Same for the crew mate. */
  defaultCrewMate: DriverInput | null;
  /**
   * Set by applyDayCrewPlan: the people above are the crew of the day, already
   * checked for absences and working days; `blocked` says why the vehicle
   * cannot work that day.
   */
  dayCrew?: { blocked: string | null };
};

export type TripInput = {
  id: string;
  patientId: string;
  /** Not sent to the optimizer: pairs the outbound and return legs of a day (patient absent on the outbound leg). */
  recurrenceId: string | null;
  facilityId: string | null;
  direction: TripDirection;
  status: TripStatus;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  appointmentMinute: number | null;
  readyMinute: number | null;
  allowedVehicleTypes: VehicleType[];
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
  lockedVehicleId: string | null;
};

export type SettingsInput = Pick<
  AppSettings,
  | "waitBeforeAppointmentMin"
  | "waitAfterSessionMin"
  | "maxTotalWaitMin"
  | "maxDetourKmPerExtraPatient"
  | "maxDetourKmTotal"
  | "pickupServiceMin"
  | "dropoffServiceMin"
  | "unassignedPenalty"
  | "solverTimeLimitSec"
>;

export type TariffInput = Pick<
  TariffGrid,
  | "vehicleType"
  | "department"
  | "baseFare"
  | "pricePerKm"
  | "includedKm"
  | "sharedDiscount2"
  | "sharedDiscount3"
  | "validFrom"
  | "validTo"
  // Not sent to the optimizer: break same-day ties between grids (tariffsInForce).
  | "createdAt"
  | "id"
>;

export type OptimizeInput = {
  date: string;
  settings: SettingsInput;
  /** When a new plan may replace the routes in place without confirmation (AppSettings); defaults when absent. */
  replan?: ReplaceThresholds;
  vehicles: VehicleInput[];
  trips: TripInput[];
  tariffs: TariffInput[];
  /** Absent: free-flow travel times (the planning view only needs vehicle availability). */
  traffic?: TrafficInput;
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type SkippedVehicle = { vehicleId: string; label: string; type: VehicleType; reason: string };
export type DroppedLock = { tripId: string; vehicleId: string; vehicleLabel: string | null; reason: string };
export type ExcludedTrip = { tripId: string; reason: string };

/** People sent with a vehicle: the route saved for it gets the same crew. */
export type VehicleCrewIds = { driverId: string; crewMateId: string | null };

export type VehicleAvailability = {
  /** Contract vehicles that can work that day, in display order. */
  available: OptimizerVehicle[];
  /** Crew of each available vehicle. */
  crews: Map<string, VehicleCrewIds>;
  skipped: SkippedVehicle[];
  /** Non-blocking remarks (break ignored, etc.). */
  notes: string[];
};

export type BuildResult = {
  request: OptimizeRequest;
  /** Crew of each vehicle of the request (savePlan gives it to the route). */
  crews: Map<string, VehicleCrewIds>;
  skippedVehicles: SkippedVehicle[];
  droppedLocks: DroppedLock[];
  excludedTrips: ExcludedTrip[];
  notes: string[];
  /** Available vehicles no tariff grid covers that day: their revenue is estimated at 0 €. */
  tariffGaps: TariffGap[];
};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * Solver budget actually sent for a day of `tripCount` trips: the configured
 * time limit, raised to one second per TRIPS_PER_SOLVER_SECOND trips so a
 * busy day is not cut short, capped at the contract maximum.
 */
export function effectiveTimeLimitSec(configuredSec: number, tripCount: number): number {
  return Math.min(CONTRACT_MAX_TIME_LIMIT_SEC, Math.max(configuredSec, Math.ceil(tripCount / TRIPS_PER_SOLVER_SECOND)));
}

/**
 * Whether a run still RUNNING at `now` should have finished long ago: its
 * budget is recomputed from the trips it sent, so a large day is not
 * declared interrupted while the solver is still working on it.
 */
export function isStaleRun(run: { startedAt: Date; tripsCount: number }, configuredSec: number, now: Date): boolean {
  const budgetSec = effectiveTimeLimitSec(configuredSec, run.tripsCount) + STALE_RUN_MARGIN_SEC;
  return run.startedAt.getTime() < now.getTime() - budgetSec * 1000;
}

/** Contract settings of a request that sends `tripCount` trips. */
export function toContractSettings(settings: SettingsInput, tripCount: number): OptimizerSettings {
  return {
    waitBeforeAppointmentMin: settings.waitBeforeAppointmentMin,
    waitAfterSessionMin: settings.waitAfterSessionMin,
    maxTotalWaitMin: settings.maxTotalWaitMin,
    maxDetourKmPerExtraPatient: settings.maxDetourKmPerExtraPatient,
    maxDetourKmTotal: settings.maxDetourKmTotal,
    pickupServiceMin: settings.pickupServiceMin,
    dropoffServiceMin: settings.dropoffServiceMin,
    unassignedPenalty: settings.unassignedPenalty,
    timeLimitSec: effectiveTimeLimitSec(settings.solverTimeLimitSec, tripCount),
  };
}

export function personName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

function isDayMinute(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_DAY_MINUTE;
}

function worksOn(person: DriverInput, weekday: number): boolean {
  return person.workDays.includes(weekday);
}

/** Display order: type (taxi, VSL, ambulance), then label. */
export function compareVehicles(
  a: { type: VehicleType; label: string },
  b: { type: VehicleType; label: string },
): number {
  return VEHICLE_TYPE_ORDER[a.type] - VEHICLE_TYPE_ORDER[b.type] || a.label.localeCompare(b.label, "fr", { numeric: true });
}

type VehicleDecision =
  | { ok: true; vehicle: OptimizerVehicle; people: string[]; notes: string[] }
  | { ok: false; reason: string };

/**
 * Can this vehicle work on `weekday`? Its driver must be active and work that
 * day; an ambulance also needs a crew mate working that day. The shift is the
 * driver's, intersected with the crew mate's for an ambulance. A crew of the
 * day (`dayCrew`) was checked for the date already: an explicit assignment on
 * a day the person does not usually work (weekend duty) is kept.
 */
export function decideVehicle(vehicle: VehicleInput, weekday: number): VehicleDecision {
  const dayLabel = (WEEKDAY_LABELS[weekday] ?? "").toLowerCase();
  if (vehicle.dayCrew?.blocked) return { ok: false, reason: vehicle.dayCrew.blocked };
  const ofTheDay = vehicle.dayCrew !== undefined;
  const driver = vehicle.defaultDriver;
  if (!driver) return { ok: false, reason: "Aucun chauffeur attitré" };
  if (!driver.active) return { ok: false, reason: `Chauffeur inactif (${personName(driver)})` };
  if (!ofTheDay && !worksOn(driver, weekday)) {
    return { ok: false, reason: `Chauffeur absent le ${dayLabel} (${personName(driver)})` };
  }

  let shiftStart = driver.shiftStartMinute;
  let shiftEnd = driver.shiftEndMinute;
  let costPerHour = driver.hourlyCost;
  const people = [driver.id];

  if (vehicle.type === "AMBULANCE") {
    const mate = vehicle.defaultCrewMate;
    if (!mate) return { ok: false, reason: "Ambulance sans équipier attitré (équipage de 2 requis)" };
    if (mate.id === driver.id) return { ok: false, reason: "Le chauffeur et l'équipier sont la même personne" };
    if (!mate.active) return { ok: false, reason: `Équipier inactif (${personName(mate)})` };
    if (!ofTheDay && !worksOn(mate, weekday)) {
      return { ok: false, reason: `Équipier absent le ${dayLabel} (${personName(mate)})` };
    }
    shiftStart = Math.max(shiftStart, mate.shiftStartMinute);
    shiftEnd = Math.min(shiftEnd, mate.shiftEndMinute);
    costPerHour += mate.hourlyCost;
    people.push(mate.id);
    if (shiftEnd <= shiftStart) {
      return { ok: false, reason: "Horaires du chauffeur et de l'équipier sans recouvrement" };
    }
  }

  if (!isDayMinute(shiftStart) || !isDayMinute(shiftEnd) || shiftEnd <= shiftStart) {
    return { ok: false, reason: `Horaires du chauffeur invalides (${personName(driver)})` };
  }

  const notes: string[] = [];
  let breakRule: OptimizerVehicle["break"] = null;
  const ws = driver.breakWindowStartMinute;
  const we = driver.breakWindowEndMinute;
  if (ws !== null && we !== null && driver.breakMinutes > 0) {
    // The break must fit inside the working hours to be schedulable.
    const windowStart = Math.max(ws, shiftStart);
    const windowEnd = Math.min(we, shiftEnd);
    if (windowEnd - windowStart >= driver.breakMinutes) {
      breakRule = { windowStartMin: windowStart, windowEndMin: windowEnd, durationMin: driver.breakMinutes };
    } else {
      notes.push(`${vehicle.label} : pause ignorée, la fenêtre de pause ne laisse pas ${driver.breakMinutes} min dans l'horaire`);
    }
  }

  return {
    ok: true,
    people,
    notes,
    vehicle: {
      id: vehicle.id,
      label: vehicle.label,
      type: vehicle.type,
      // Business rule: an ambulance carries one patient, whatever is stored.
      capacity: vehicle.type === "AMBULANCE" ? 1 : Math.min(Math.max(vehicle.capacity, 1), MAX_CAPACITY),
      depot: { lat: vehicle.depot.lat, lng: vehicle.depot.lng },
      department: vehicle.department,
      costPerKm: vehicle.costPerKm,
      costPerHour,
      shiftStartMin: shiftStart,
      shiftEndMin: shiftEnd,
      break: breakRule,
    },
  };
}

/**
 * Vehicles available on isoDate. Inactive vehicles are left out silently. A
 * person cannot drive or crew two vehicles at once: the first vehicle in
 * display order keeps them, the others are reported as skipped.
 */
export function resolveVehicleAvailability(vehicles: VehicleInput[], isoDate: string): VehicleAvailability {
  const weekday = isoWeekday(isoDate);
  const available: OptimizerVehicle[] = [];
  const crews = new Map<string, VehicleCrewIds>();
  const skipped: SkippedVehicle[] = [];
  const notes: string[] = [];
  const takenBy = new Map<string, string>();

  for (const vehicle of [...vehicles].sort(compareVehicles)) {
    if (!vehicle.active) continue;
    const decision = decideVehicle(vehicle, weekday);
    if (!decision.ok) {
      skipped.push({ vehicleId: vehicle.id, label: vehicle.label, type: vehicle.type, reason: decision.reason });
      continue;
    }
    const conflict = decision.people.find((id) => takenBy.has(id));
    if (conflict) {
      const role = conflict === vehicle.defaultDriver?.id ? "Chauffeur" : "Équipier";
      skipped.push({
        vehicleId: vehicle.id,
        label: vehicle.label,
        type: vehicle.type,
        reason: `${role} déjà affecté à ${takenBy.get(conflict)} ce jour`,
      });
      continue;
    }
    for (const id of decision.people) takenBy.set(id, vehicle.label);
    available.push(decision.vehicle);
    crews.set(vehicle.id, { driverId: decision.people[0] ?? "", crewMateId: decision.people[1] ?? null });
    notes.push(...decision.notes);
  }
  return { available, crews, skipped, notes };
}

function lockDropReason(
  lockedVehicleId: string,
  trip: TripInput,
  available: Map<string, OptimizerVehicle>,
  skipped: Map<string, SkippedVehicle>,
  allVehicles: Map<string, VehicleInput>,
): string | null {
  const vehicle = available.get(lockedVehicleId);
  if (vehicle) {
    return trip.allowedVehicleTypes.includes(vehicle.type) ? null : "Type de véhicule non autorisé pour cette course";
  }
  const skip = skipped.get(lockedVehicleId);
  if (skip) return `Véhicule indisponible ce jour : ${skip.reason}`;
  if (allVehicles.get(lockedVehicleId)?.active === false) return "Véhicule inactif";
  return "Véhicule introuvable";
}

/** Why a trip cannot be sent to the optimizer, or null when it can. */
export function tripExclusionReason(trip: TripInput): string | null {
  if (trip.allowedVehicleTypes.length === 0) return "Aucun type de véhicule autorisé";
  if (trip.direction === "OUTBOUND") {
    if (trip.appointmentMinute === null) return "Aller sans heure de rendez-vous";
    if (!isDayMinute(trip.appointmentMinute)) return "Heure de rendez-vous hors de la journée";
  } else {
    if (trip.readyMinute === null) return "Retour sans heure de fin de séance";
    if (!isDayMinute(trip.readyMinute)) return "Heure de fin de séance hors de la journée";
  }
  return null;
}

export function toContractTariffs(grids: TariffInput[], isoDate: string): OptimizerTariff[] {
  return tariffsInForce(grids, isoDate)
    .map((g) => ({
      vehicleType: g.vehicleType,
      department: g.department,
      baseFare: g.baseFare,
      pricePerKm: g.pricePerKm,
      includedKm: g.includedKm,
      sharedDiscount2: g.sharedDiscount2,
      sharedDiscount3: g.sharedDiscount3,
    }))
    .sort((a, b) => VEHICLE_TYPE_ORDER[a.vehicleType] - VEHICLE_TYPE_ORDER[b.vehicleType] || a.department.localeCompare(b.department));
}

/** Pure: the optimizer request of input.date, plus everything left out and why. */
export function buildOptimizeRequest(input: OptimizeInput): BuildResult {
  const { available, crews, skipped, notes } = resolveVehicleAvailability(input.vehicles, input.date);
  const availableById = new Map(available.map((v) => [v.id, v]));
  const skippedById = new Map(skipped.map((s) => [s.vehicleId, s]));
  const allById = new Map(input.vehicles.map((v) => [v.id, v]));

  const trips: OptimizerTrip[] = [];
  const droppedLocks: DroppedLock[] = [];
  const excludedTrips: ExcludedTrip[] = [];

  for (const trip of input.trips) {
    if (EXCLUDED_TRIP_STATUSES.includes(trip.status)) continue;
    const exclusion = tripExclusionReason(trip);
    if (exclusion) {
      excludedTrips.push({ tripId: trip.id, reason: exclusion });
      continue;
    }

    let lockedVehicleId = trip.lockedVehicleId;
    if (lockedVehicleId) {
      const reason = lockDropReason(lockedVehicleId, trip, availableById, skippedById, allById);
      if (reason) {
        droppedLocks.push({
          tripId: trip.id,
          vehicleId: lockedVehicleId,
          vehicleLabel: allById.get(lockedVehicleId)?.label ?? null,
          reason,
        });
        lockedVehicleId = null;
      }
    }

    trips.push({
      id: trip.id,
      patientId: trip.patientId,
      facilityId: trip.facilityId,
      direction: trip.direction,
      pickup: { lat: trip.pickupLat, lng: trip.pickupLng },
      dropoff: { lat: trip.dropoffLat, lng: trip.dropoffLng },
      appointmentMin: trip.direction === "OUTBOUND" ? trip.appointmentMinute : null,
      readyMin: trip.direction === "RETURN" ? trip.readyMinute : null,
      allowedVehicleTypes: [...new Set(trip.allowedVehicleTypes)],
      shareable: isShareable(trip),
      lockedVehicleId,
    });
  }

  const tariffs = toContractTariffs(input.tariffs, input.date);
  return {
    request: {
      date: input.date,
      settings: {
        ...toContractSettings(input.settings, trips.length),
        ...(input.traffic ? { traffic: toContractTraffic(input.traffic, input.date) } : {}),
      },
      vehicles: available,
      trips,
      tariffs,
    },
    crews,
    skippedVehicles: skipped,
    droppedLocks,
    excludedTrips,
    notes,
    tariffGaps: tariffGaps(
      available.map((v) => ({ label: v.label, type: v.type, department: v.department })),
      tariffs,
    ),
  };
}

// ---------------------------------------------------------------------------
// DB loader
// ---------------------------------------------------------------------------

export const driverInputSelect = {
  id: true,
  firstName: true,
  lastName: true,
  active: true,
  workDays: true,
  shiftStartMinute: true,
  shiftEndMinute: true,
  breakWindowStartMinute: true,
  breakWindowEndMinute: true,
  breakMinutes: true,
  hourlyCost: true,
} as const;

export const vehicleInputSelect = {
  id: true,
  label: true,
  type: true,
  capacity: true,
  depot: { select: { lat: true, lng: true } },
  department: true,
  costPerKm: true,
  active: true,
  defaultDriver: { select: driverInputSelect },
  defaultCrewMate: { select: driverInputSelect },
} as const;

export const tripInputSelect = {
  id: true,
  patientId: true,
  recurrenceId: true,
  facilityId: true,
  direction: true,
  status: true,
  pickupLat: true,
  pickupLng: true,
  dropoffLat: true,
  dropoffLng: true,
  appointmentMinute: true,
  readyMinute: true,
  allowedVehicleTypes: true,
  sharingAllowed: true,
  sharingStatus: true,
  lockedVehicleId: true,
} as const;

/** Every vehicle (active or not: locks may point to an inactive one) with its default crew. */
export function loadVehicleInputs(prisma: PrismaClient): Promise<VehicleInput[]> {
  return prisma.vehicle.findMany({ select: vehicleInputSelect, orderBy: { label: "asc" } });
}

/**
 * Pure: the vehicles with the crew of the day in place of their default crew
 * (see VehicleInput.dayCrew). A vehicle the plan does not know (inactive) is
 * returned unchanged.
 */
export function applyDayCrewPlan<V extends VehicleInput>(
  vehicles: readonly V[],
  plan: { crews: readonly Pick<DayCrewView, "vehicleId" | "driverId" | "crewMateId" | "blocked">[] },
  people: ReadonlyMap<string, DriverInput>,
): V[] {
  const byVehicle = new Map(plan.crews.map((c) => [c.vehicleId, c]));
  return vehicles.map((vehicle) => {
    const crew = byVehicle.get(vehicle.id);
    if (!crew) return vehicle;
    return {
      ...vehicle,
      defaultDriver: crew.driverId ? (people.get(crew.driverId) ?? null) : null,
      defaultCrewMate: crew.crewMateId ? (people.get(crew.crewMateId) ?? null) : null,
      dayCrew: { blocked: crew.blocked },
    };
  });
}

/** A crew fixed for the date (DayCrew row): its version for the concurrency check, and its author. */
export type SavedCrewMeta = { id: string; updatedAt: Date; updatedBy: string | null };

export type DayCrewContext = {
  /** What the plan was resolved from: resolve it again with other fixed crews (crew form). */
  input: DayCrewInput;
  plan: DayCrewPlan;
  /** Fixed crews of the date by vehicle id. */
  savedMeta: Map<string, SavedCrewMeta>;
  /** Every person, active or not, by id. */
  people: Map<string, DriverInput & StaffPerson>;
  /**
   * Vehicles whose inspection or insurance is overdue on the date (lib/fleet
   * complianceAlerts), with the alerts. Reported, not blocking (PO question).
   */
  fleetAlerts: Map<string, string[]>;
};

/** Everything the crews of isoDate depend on, resolved (lib/staff/day-crews.ts). */
export async function loadDayCrewContext(prisma: PrismaClient, isoDate: string): Promise<DayCrewContext> {
  const serviceDate = fromIsoDate(isoDate);
  const [vehicles, people, absences, incompatibilities, saved, outages, deadlines, odometers, depots, rules] = await Promise.all([
    prisma.vehicle.findMany({
      select: { id: true, label: true, type: true, active: true, depotId: true, defaultDriverId: true, defaultCrewMateId: true },
    }),
    prisma.driver.findMany({ select: { ...driverInputSelect, qualifications: true, depotId: true } }),
    prisma.staffAbsence.findMany({
      where: { startDate: { lte: serviceDate }, endDate: { gte: serviceDate } },
      select: { driverId: true, kind: true, startDate: true, endDate: true },
    }),
    prisma.crewIncompatibility.findMany({ select: { driverAId: true, driverBId: true } }),
    prisma.dayCrew.findMany({
      where: { serviceDate },
      select: { id: true, vehicleId: true, driverId: true, crewMateId: true, updatedAt: true, updatedBy: { select: { name: true } } },
    }),
    prisma.vehicleUnavailability.findMany({
      where: { startDate: { lte: serviceDate }, endDate: { gte: serviceDate } },
      select: { vehicleId: true, kind: true, startDate: true, endDate: true },
    }),
    prisma.maintenanceDeadline.findMany({
      where: { kind: { in: [...COMPLIANCE_KINDS] }, doneDate: null },
      select: { vehicleId: true, kind: true, label: true, dueDate: true, dueKm: true, doneDate: true },
    }),
    prisma.fuelLog.groupBy({ by: ["vehicleId"], _max: { odometerKm: true } }),
    prisma.depot.findMany({ select: { id: true, name: true, lat: true, lng: true } }),
    loadCrewRules(prisma),
  ]);
  const odometerOf = new Map(odometers.map((o) => [o.vehicleId, o._max.odometerKm ?? null]));
  const fleetAlerts = new Map<string, string[]>();
  for (const vehicle of vehicles) {
    const own = deadlines
      .filter((d) => d.vehicleId === vehicle.id)
      .map((d) => ({ ...d, dueDate: d.dueDate ? toIsoDate(d.dueDate) : null, doneDate: d.doneDate ? toIsoDate(d.doneDate) : null }));
    const alerts = own.length > 0 ? complianceAlerts(own, isoDate, odometerOf.get(vehicle.id) ?? null) : [];
    if (alerts.length > 0) fleetAlerts.set(vehicle.id, alerts);
  }
  const input: DayCrewInput = {
    date: isoDate,
    vehicles,
    people,
    absences: absences.map((a) => ({ ...a, startDate: toIsoDate(a.startDate), endDate: toIsoDate(a.endDate) })),
    incompatibilities,
    saved: saved.map((s) => ({ vehicleId: s.vehicleId, driverId: s.driverId, crewMateId: s.crewMateId })),
    vehicleUnavailabilities: outages.map((u) => ({ ...u, startDate: toIsoDate(u.startDate), endDate: toIsoDate(u.endDate) })),
    depots,
    rules,
  };
  const savedMeta = new Map(saved.map((s) => [s.vehicleId, { id: s.id, updatedAt: s.updatedAt, updatedBy: s.updatedBy?.name ?? null }]));
  return { input, plan: resolveDayCrews(input), savedMeta, people: new Map(people.map((p) => [p.id, p])), fleetAlerts };
}

/** Settings of the automatic crews (Paramètres « Équipages »); the schema defaults before the row exists. Read only. */
export async function loadCrewRules(prisma: Pick<PrismaClient, "appSettings">): Promise<CrewRules> {
  const row = await prisma.appSettings.findUnique({
    where: { id: 1 },
    select: { crewMaxReplacementKm: true, crewMinPairOverlapMin: true, crewReservePerDepot: true },
  });
  if (!row) return DEFAULT_CREW_RULES;
  return {
    maxReplacementKm: row.crewMaxReplacementKm,
    minPairOverlapMin: row.crewMinPairOverlapMin,
    reservePerDepot: row.crewReservePerDepot,
  };
}

/** Every vehicle with the crew of isoDate (optimisation, planning view, moves). */
export async function loadDayVehicleInputs(prisma: PrismaClient, isoDate: string): Promise<VehicleInput[]> {
  const [vehicles, context] = await Promise.all([loadVehicleInputs(prisma), loadDayCrewContext(prisma, isoDate)]);
  return applyDayCrewPlan(vehicles, context.plan, context.people);
}

/** Tariff grids that may be in force on isoDate (tariffsInForce picks one per type and department). */
export function loadTariffInputs(prisma: PrismaClient, isoDate: string): Promise<TariffInput[]> {
  const serviceDate = fromIsoDate(isoDate);
  return prisma.tariffGrid.findMany({
    where: { validFrom: { lte: serviceDate }, OR: [{ validTo: null }, { validTo: { gte: serviceDate } }] },
  });
}

export async function loadOptimizeInput(prisma: PrismaClient, isoDate: string): Promise<OptimizeInput> {
  const serviceDate = fromIsoDate(isoDate);
  const [settings, zones, vehicles, trips, tariffs] = await Promise.all([
    getSettings(prisma),
    loadTrafficZones(prisma),
    loadDayVehicleInputs(prisma, isoDate),
    prisma.trip.findMany({
      where: { serviceDate, status: { notIn: [...EXCLUDED_TRIP_STATUSES] } },
      select: tripInputSelect,
      orderBy: [{ appointmentMinute: "asc" }, { readyMinute: "asc" }, { id: "asc" }],
    }),
    loadTariffInputs(prisma, isoDate),
  ]);
  return {
    date: isoDate,
    settings,
    replan: { maxServedLoss: settings.replanMaxServedLoss, maxMarginLoss: settings.replanMaxMarginLoss },
    vehicles,
    trips,
    tariffs,
    traffic: { ...settings, zones },
  };
}

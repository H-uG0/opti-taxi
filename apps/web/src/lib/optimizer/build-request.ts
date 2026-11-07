/**
 * Builds the OptimizeRequest of a service date.
 *
 * Two layers:
 * - `buildOptimizeRequest` (pure): business rules deciding which vehicles can
 *   work that day, which trips are sent, which locks are kept. Unit-tested.
 * - `loadOptimizeInput` (DB): reads everything the builder needs. It receives
 *   the Prisma client as a parameter so this module has no server-only import.
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
import { tariffsInForce } from "@/lib/domain/tariffs";
import { fromIsoDate, isoWeekday, WEEKDAY_LABELS } from "@/lib/time";
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
  defaultDriver: DriverInput | null;
  defaultCrewMate: DriverInput | null;
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

export type VehicleAvailability = {
  /** Contract vehicles that can work that day, in display order. */
  available: OptimizerVehicle[];
  skipped: SkippedVehicle[];
  /** Non-blocking remarks (break ignored, etc.). */
  notes: string[];
};

export type BuildResult = {
  request: OptimizeRequest;
  skippedVehicles: SkippedVehicle[];
  droppedLocks: DroppedLock[];
  excludedTrips: ExcludedTrip[];
  notes: string[];
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
 * Can this vehicle work on `weekday`? Its default driver must be active and
 * work that day; an ambulance also needs a crew mate working that day. The
 * shift is the driver's, intersected with the crew mate's for an ambulance.
 */
export function decideVehicle(vehicle: VehicleInput, weekday: number): VehicleDecision {
  const dayLabel = (WEEKDAY_LABELS[weekday] ?? "").toLowerCase();
  const driver = vehicle.defaultDriver;
  if (!driver) return { ok: false, reason: "Aucun chauffeur attitré" };
  if (!driver.active) return { ok: false, reason: `Chauffeur inactif (${personName(driver)})` };
  if (!worksOn(driver, weekday)) {
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
    if (!worksOn(mate, weekday)) {
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
    notes.push(...decision.notes);
  }
  return { available, skipped, notes };
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
  const { available, skipped, notes } = resolveVehicleAvailability(input.vehicles, input.date);
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

  return {
    request: {
      date: input.date,
      settings: {
        ...toContractSettings(input.settings, trips.length),
        ...(input.traffic ? { traffic: toContractTraffic(input.traffic, input.date) } : {}),
      },
      vehicles: available,
      trips,
      tariffs: toContractTariffs(input.tariffs, input.date),
    },
    skippedVehicles: skipped,
    droppedLocks,
    excludedTrips,
    notes,
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

/** Every vehicle (active or not: locks may point to an inactive one) with its crew. */
export function loadVehicleInputs(prisma: PrismaClient): Promise<VehicleInput[]> {
  return prisma.vehicle.findMany({ select: vehicleInputSelect, orderBy: { label: "asc" } });
}

export async function loadOptimizeInput(prisma: PrismaClient, isoDate: string): Promise<OptimizeInput> {
  const serviceDate = fromIsoDate(isoDate);
  const [settings, zones, vehicles, trips, tariffs] = await Promise.all([
    getSettings(prisma),
    loadTrafficZones(prisma),
    loadVehicleInputs(prisma),
    prisma.trip.findMany({
      where: { serviceDate, status: { notIn: [...EXCLUDED_TRIP_STATUSES] } },
      select: tripInputSelect,
      orderBy: [{ appointmentMinute: "asc" }, { readyMinute: "asc" }, { id: "asc" }],
    }),
    prisma.tariffGrid.findMany({
      where: { validFrom: { lte: serviceDate }, OR: [{ validTo: null }, { validTo: { gte: serviceDate } }] },
    }),
  ]);
  return { date: isoDate, settings, vehicles, trips, tariffs, traffic: { ...settings, zones } };
}

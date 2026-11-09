/**
 * Pure assembly of the planning page view model from database rows.
 * No database access here: see ./load.ts for the queries.
 */
import type {
  OptimizationRunStatus,
  Payer,
  RouteStatus,
  StopKind,
  TripStatus,
  VehicleType,
} from "@prisma/client";
import {
  buildOptimizeRequest,
  compareVehicles,
  effectiveTimeLimitSec,
  EXCLUDED_TRIP_STATUSES,
  isStaleRun,
  personName,
  type SettingsInput,
  type TripInput,
  type VehicleInput,
} from "@/lib/optimizer/build-request";
import type { RunDetails } from "@/lib/optimizer/run-details";
import { returnsToCheckAfterNoShow } from "@/lib/domain/no-show";
import { computeDayKpis as computeDashboardDayKpis, type KpiRoute, type KpiTrip } from "@/lib/kpis";
import { VIOLATION_LABELS } from "@/lib/labels";
import { vehicleShade } from "./colors";
import { resolveTripRefs } from "./move";
import { coPassengers, computeTimeRange } from "./timeline";
import type {
  DayKpis,
  DayStatus,
  FieldRecordView,
  PlanningDayView,
  RecordedByView,
  RouteView,
  RunView,
  StopView,
  TripView,
  UnassignedView,
  VehicleRowView,
  ViolationView,
} from "./types";

type Person = { firstName: string; lastName: string };

/** Account that recorded a value: only its name is loaded. */
type Recorder = { name: string } | null;

export type RawVehicle = Omit<VehicleInput, "depot"> & {
  registration: string;
  depot: VehicleInput["depot"] & { name: string };
};

export type RawTrip = TripInput & {
  payer: Payer;
  pickupAddress: string;
  dropoffAddress: string;
  routeId: string | null;
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
  shared: boolean;
  directKm: number | null;
  detourKm: number | null;
  estimatedRevenue: number | null;
  createdAt: Date;
  sharingRespondedAt: Date | null;
  sharingRespondedBy: Recorder;
  patient: Person;
  facility: { name: string } | null;
};

export type RawStop = {
  id: string;
  sequence: number;
  tripId: string;
  kind: StopKind;
  lat: number;
  lng: number;
  address: string;
  arrivalMinute: number;
  startMinute: number;
  departureMinute: number;
  loadAfter: number;
  completedAt: Date | null;
  completedBy: Recorder;
};

export type RawRoute = {
  id: string;
  vehicleId: string;
  status: RouteStatus;
  startMinute: number;
  endMinute: number;
  distanceKm: number;
  emptyKm: number;
  revenue: number;
  cost: number;
  margin: number;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
  validatedAt: Date | null;
  driver: Person | null;
  crewMate: Person | null;
  stops: RawStop[];
};

export type RawRun = {
  id: string;
  status: OptimizationRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  wallTimeMs: number | null;
  matrixSource: string | null;
  valid: boolean | null;
  error: string | null;
  tripsCount: number;
  lockedCount: number;
  unassignedCount: number;
  requestedBy: { name: string } | null;
};

export type PlanningRawInput = {
  date: string;
  settings: SettingsInput;
  vehicles: RawVehicle[];
  trips: RawTrip[];
  routes: RawRoute[];
  lastRun: RawRun | null;
  planRun: RawRun | null;
  details: ReadonlyMap<string, RunDetails>;
  baseColors: Record<VehicleType, string>;
  /** Time of the page load, to tell a live RUNNING run from an interrupted one; defaults to the current time. */
  now?: Date;
};

const FIELD_STATUSES: readonly TripStatus[] = ["PICKED_UP", "DROPPED_OFF"];

function isActiveTrip(status: TripStatus): boolean {
  return !EXCLUDED_TRIP_STATUSES.includes(status);
}

function tripTime(trip: { appointmentMinute: number | null; readyMinute: number | null; plannedPickupMinute: number | null }): number {
  return trip.plannedPickupMinute ?? trip.appointmentMinute ?? trip.readyMinute ?? 0;
}

export function waitAtFacility(trip: {
  direction: "OUTBOUND" | "RETURN";
  appointmentMinute: number | null;
  readyMinute: number | null;
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
}): number | null {
  if (trip.direction === "OUTBOUND") {
    return trip.appointmentMinute !== null && trip.plannedDropoffMinute !== null
      ? trip.appointmentMinute - trip.plannedDropoffMinute
      : null;
  }
  return trip.readyMinute !== null && trip.plannedPickupMinute !== null ? trip.plannedPickupMinute - trip.readyMinute : null;
}

/** The recorder's name, null when no account was recorded (or a blank name). */
function recorderName(recorder: Recorder): string | null {
  return recorder?.name.trim() || null;
}

/**
 * When and by whom the patient's sharing answer was last recorded; null when
 * none was. Kept after the answer is reset (prescription changed), as /courses
 * shows it.
 */
export function sharingAnswerOf(trip: Pick<RawTrip, "sharingRespondedAt" | "sharingRespondedBy">): RecordedByView | null {
  if (!trip.sharingRespondedAt) return null;
  return { at: trip.sharingRespondedAt.toISOString(), byName: recorderName(trip.sharingRespondedBy) };
}

/** Stop statuses recorded by the crew, per trip, in route order. */
export function fieldRecordsByTrip(
  routes: ReadonlyArray<{ stops: ReadonlyArray<Pick<RawStop, "id" | "sequence" | "tripId" | "kind" | "completedAt" | "completedBy">> }>,
): Map<string, FieldRecordView[]> {
  const byTrip = new Map<string, FieldRecordView[]>();
  for (const route of routes) {
    for (const stop of [...route.stops].sort((a, b) => a.sequence - b.sequence)) {
      if (!stop.completedAt) continue;
      const record: FieldRecordView = {
        stopId: stop.id,
        kind: stop.kind,
        at: stop.completedAt.toISOString(),
        byName: recorderName(stop.completedBy),
      };
      const list = byTrip.get(stop.tripId);
      if (list) list.push(record);
      else byTrip.set(stop.tripId, [record]);
    }
  }
  return byTrip;
}

/** The stop as the timeline draws it (recorded instants and names stay out). */
function toStopView(stop: RawStop): StopView {
  return {
    id: stop.id,
    sequence: stop.sequence,
    tripId: stop.tripId,
    kind: stop.kind,
    lat: stop.lat,
    lng: stop.lng,
    address: stop.address,
    arrivalMinute: stop.arrivalMinute,
    startMinute: stop.startMinute,
    departureMinute: stop.departureMinute,
    loadAfter: stop.loadAfter,
    completed: stop.completedAt !== null,
  };
}

function runView(
  run: RawRun | null,
  details: ReadonlyMap<string, RunDetails>,
  configuredSec: number,
  now: Date,
  patientOf: (tripId: string) => string | null,
): RunView | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    wallTimeMs: run.wallTimeMs,
    matrixSource: run.matrixSource,
    trafficSource: details.get(run.id)?.trafficSource ?? null,
    valid: run.valid,
    // A refused move names its trip by id in the stored error (move.ts): the patient's name is put in here.
    error: run.error === null ? null : resolveTripRefs(run.error, patientOf),
    tripsCount: run.tripsCount,
    lockedCount: run.lockedCount,
    unassignedCount: run.unassignedCount,
    requestedBy: run.requestedBy?.name ?? null,
    warnings: details.get(run.id)?.warnings ?? null,
    timeLimitSec: effectiveTimeLimitSec(configuredSec, run.tripsCount),
    // Same rule as the stale-run cleanup of runOptimization (run-optimization.ts).
    interrupted: run.status === "RUNNING" && isStaleRun(run, configuredSec, now),
  };
}

export type KpiTripSource = Pick<
  RawTrip,
  "id" | "status" | "routeId" | "direction" | "shared" | "appointmentMinute" | "plannedDropoffMinute"
>;
export type KpiRouteSource = Pick<
  RawRoute,
  "vehicleId" | "distanceKm" | "emptyKm" | "revenue" | "cost" | "margin" | "validatedAt"
> & { stops: ReadonlyArray<Pick<RawStop, "tripId" | "kind" | "completedAt">> };

/**
 * The planning rows of `date` as the dashboard reads them from the database
 * (tableau-de-bord/load-kpis.ts): stop count and recorded status per route,
 * real drop-off instant per trip.
 */
export function toKpiRows(
  date: string,
  trips: readonly KpiTripSource[],
  routes: readonly KpiRouteSource[],
): { routes: KpiRoute[]; trips: KpiTrip[] } {
  const dropoffAt = new Map<string, Date>();
  for (const stop of routes.flatMap((r) => r.stops)) {
    if (stop.kind !== "DROPOFF" || !stop.completedAt) continue;
    const latest = dropoffAt.get(stop.tripId);
    if (!latest || stop.completedAt > latest) dropoffAt.set(stop.tripId, stop.completedAt);
  }
  return {
    routes: routes.map((r) => ({
      serviceDate: date,
      vehicleId: r.vehicleId,
      distanceKm: r.distanceKm,
      emptyKm: r.emptyKm,
      revenue: r.revenue,
      cost: r.cost,
      margin: r.margin,
      validatedAt: r.validatedAt,
      stopCount: r.stops.length,
      hasRecordedStatus: r.stops.some((s) => s.completedAt !== null),
    })),
    trips: trips.map((t) => ({
      serviceDate: date,
      status: t.status,
      routeId: t.routeId,
      direction: t.direction,
      shared: t.shared,
      appointmentMinute: t.appointmentMinute,
      plannedDropoffMinute: t.plannedDropoffMinute,
      dropoffCompletedAt: dropoffAt.get(t.id) ?? null,
    })),
  };
}

/**
 * KPIs of the day from the saved routes and trips (always current), with the
 * dashboard formulas of @/lib/kpis: served trips, used vehicles, km, shared
 * rate and money are computed there, so both pages show the same numbers.
 */
export function computeDayKpis(
  date: string,
  trips: readonly KpiTripSource[],
  routes: readonly KpiRouteSource[],
  violations: number | null,
): DayKpis {
  // Only planned figures are read: `today` (here the date itself) does not change them.
  const day = computeDashboardDayKpis(date, { ...toKpiRows(date, trips, routes), runs: [] }, date);
  return {
    tripsTotal: trips.filter((t) => isActiveTrip(t.status)).length,
    tripsServed: day.servedTrips,
    vehiclesUsed: day.vehicles,
    tripsPerVehicle: day.tripsPerVehiclePlanned,
    totalKm: day.distanceKm,
    emptyKm: day.emptyKm,
    emptyKmRatio: day.emptyKmShare,
    sharedTrips: day.sharedTrips,
    sharedTripRatio: day.sharedRate,
    revenue: day.revenue,
    margin: day.margin,
    violations,
  };
}

export function dayStatusOf(activeTrips: number, routes: Array<{ status: RouteStatus }>): DayStatus {
  if (routes.length === 0) return activeTrips === 0 ? "EMPTY" : "UNPLANNED";
  if (routes.every((r) => r.status === "VALIDATED")) return "VALIDATED";
  if (routes.every((r) => r.status === "PROPOSED")) return "PROPOSED";
  return "MIXED";
}

export function buildPlanningView(input: PlanningRawInput): PlanningDayView {
  const now = input.now ?? new Date();
  const patientNames = new Map(input.trips.map((t) => [t.id, personName(t.patient)]));
  const patientOf = (tripId: string) => patientNames.get(tripId) ?? null;
  const build = buildOptimizeRequest({
    date: input.date,
    settings: input.settings,
    vehicles: input.vehicles,
    trips: input.trips,
    tariffs: [],
  });
  const availableById = new Map(build.request.vehicles.map((v) => [v.id, v]));
  const skippedById = new Map(build.skippedVehicles.map((s) => [s.vehicleId, s]));
  const excludedById = new Map(build.excludedTrips.map((e) => [e.tripId, e.reason]));
  const vehicleById = new Map(input.vehicles.map((v) => [v.id, v]));
  const routeByVehicle = new Map(input.routes.map((r) => [r.vehicleId, r]));
  const routeById = new Map(input.routes.map((r) => [r.id, r]));

  // Colors: index of each vehicle within its type, over the whole fleet so a
  // vehicle keeps its shade from one day to the next.
  const colorById = new Map<string, string>();
  const perType: Record<VehicleType, number> = { TAXI: 0, VSL: 0, AMBULANCE: 0 };
  for (const vehicle of [...input.vehicles].sort(compareVehicles)) {
    colorById.set(vehicle.id, vehicleShade(input.baseColors[vehicle.type], perType[vehicle.type]++));
  }

  const toRouteView = (route: RawRoute): RouteView => {
    const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
    return {
      id: route.id,
      status: route.status,
      startMinute: route.startMinute,
      endMinute: route.endMinute,
      distanceKm: route.distanceKm,
      emptyKm: route.emptyKm,
      revenue: route.revenue,
      cost: route.cost,
      margin: route.margin,
      breakStartMinute: route.breakStartMinute,
      breakEndMinute: route.breakEndMinute,
      validatedAt: route.validatedAt?.toISOString() ?? null,
      tripCount: new Set(stops.map((s) => s.tripId)).size,
      stops: stops.map(toStopView),
    };
  };

  const withRoute: VehicleRowView[] = [];
  const idle: VehicleRowView[] = [];
  for (const vehicle of [...input.vehicles].sort(compareVehicles)) {
    const route = routeByVehicle.get(vehicle.id) ?? null;
    const available = availableById.get(vehicle.id);
    if (!route && !available) continue;
    const isAmbulance = vehicle.type === "AMBULANCE";
    const driver = route ? route.driver : vehicle.defaultDriver;
    const mate = route ? route.crewMate : isAmbulance ? vehicle.defaultCrewMate : null;
    const row: VehicleRowView = {
      id: vehicle.id,
      label: vehicle.label,
      registration: vehicle.registration,
      type: vehicle.type,
      capacity: available?.capacity ?? vehicle.capacity,
      color: colorById.get(vehicle.id) ?? input.baseColors[vehicle.type],
      depot: { lat: vehicle.depot.lat, lng: vehicle.depot.lng, label: vehicle.depot.name },
      driverName: driver ? personName(driver) : null,
      crewMateName: mate ? personName(mate) : null,
      available: available !== undefined,
      unavailableReason: available ? null : (skippedById.get(vehicle.id)?.reason ?? (vehicle.active ? null : "Véhicule inactif")),
      shift: available ? { start: available.shiftStartMin, end: available.shiftEndMin } : null,
      breakWindow: available?.break
        ? { start: available.break.windowStartMin, end: available.break.windowEndMin, duration: available.break.durationMin }
        : null,
      route: route ? toRouteView(route) : null,
    };
    (route ? withRoute : idle).push(row);
  }
  const rows = [...withRoute, ...idle];

  // Co-passengers from the stop sequences.
  const companions = new Map<string, Set<string>>();
  for (const route of input.routes) {
    for (const [tripId, others] of coPassengers(route.stops)) companions.set(tripId, others);
  }

  const vehicleOfTrip = (trip: RawTrip): string | null => (trip.routeId ? (routeById.get(trip.routeId)?.vehicleId ?? null) : null);
  const returnsToCheck = returnsToCheckAfterNoShow(input.trips);
  const fieldRecords = fieldRecordsByTrip(input.routes);

  const trips: TripView[] = input.trips
    .filter((t) => isActiveTrip(t.status) || vehicleOfTrip(t) !== null)
    .map((t) => {
      const vehicleId = vehicleOfTrip(t);
      return {
        id: t.id,
        direction: t.direction,
        status: t.status,
        payer: t.payer,
        patientName: personName(t.patient),
        facilityName: t.facility?.name ?? null,
        pickupAddress: t.pickupAddress,
        dropoffAddress: t.dropoffAddress,
        pickup: { lat: t.pickupLat, lng: t.pickupLng },
        dropoff: { lat: t.dropoffLat, lng: t.dropoffLng },
        appointmentMinute: t.appointmentMinute,
        readyMinute: t.readyMinute,
        allowedVehicleTypes: t.allowedVehicleTypes,
        sharingAllowed: t.sharingAllowed,
        sharingStatus: t.sharingStatus,
        sharingAnswer: sharingAnswerOf(t),
        fieldRecords: fieldRecords.get(t.id) ?? [],
        lockedVehicleId: t.lockedVehicleId,
        vehicleId,
        plannedPickupMinute: vehicleId ? t.plannedPickupMinute : null,
        plannedDropoffMinute: vehicleId ? t.plannedDropoffMinute : null,
        shared: vehicleId !== null && t.shared,
        coPassengerTripIds: [...(companions.get(t.id) ?? [])],
        directKm: t.directKm,
        detourKm: vehicleId ? t.detourKm : null,
        estimatedRevenue: vehicleId ? t.estimatedRevenue : null,
        waitAtFacilityMin: vehicleId ? waitAtFacility(t) : null,
        outboundNoShow: returnsToCheck.has(t.id),
      };
    })
    .sort((a, b) => tripTime(a) - tripTime(b));

  const rawById = new Map(input.trips.map((t) => [t.id, t]));
  const planDetails = input.planRun ? (input.details.get(input.planRun.id) ?? null) : null;
  const optimizerReasons = new Map(planDetails?.unassigned.map((u) => [u.tripId, u.reason]) ?? []);

  const unassigned: UnassignedView[] = trips
    .filter((t) => t.vehicleId === null && isActiveTrip(t.status))
    .map((t) => {
      const excluded = excludedById.get(t.id);
      let reason: string;
      if (excluded) reason = `Non envoyée à l'optimiseur : ${excluded}`;
      else if (optimizerReasons.has(t.id)) reason = optimizerReasons.get(t.id) ?? "";
      else if (!input.planRun) reason = "Pas encore optimisée";
      else if ((rawById.get(t.id)?.createdAt ?? new Date(0)) > input.planRun.startedAt) reason = "Ajoutée après la dernière optimisation";
      else reason = "Non affectée lors de la dernière optimisation";
      return { tripId: t.id, reason };
    });

  const staleTrips: UnassignedView[] = [];
  for (const t of trips) {
    if (t.vehicleId && t.status === "CANCELLED") {
      staleTrips.push({ tripId: t.id, reason: "Course annulée après l'optimisation : réoptimisez pour libérer le créneau" });
    } else if (t.vehicleId && t.status === "NO_SHOW") {
      staleTrips.push({ tripId: t.id, reason: "Patient absent : la course reste dans la tournée" });
    } else if (t.lockedVehicleId && t.vehicleId && t.lockedVehicleId !== t.vehicleId && isActiveTrip(t.status)) {
      const label = vehicleById.get(t.lockedVehicleId)?.label ?? "un autre véhicule";
      staleTrips.push({ tripId: t.id, reason: `Figée sur ${label} mais planifiée ailleurs : réoptimisez` });
    }
  }

  const violations: ViolationView[] = (planDetails?.violations ?? []).map((v) => ({
    code: v.code,
    label: VIOLATION_LABELS[v.code] ?? v.code,
    message: v.message,
    tripId: v.tripId,
    vehicleId: v.vehicleId,
  }));
  const violationsKnown = !input.planRun || input.planRun.valid !== false || planDetails !== null;

  const activeTrips = input.trips.filter((t) => isActiveTrip(t.status)).length;

  return {
    date: input.date,
    dayStatus: dayStatusOf(activeTrips, input.routes),
    vehicles: rows,
    trips,
    unassigned,
    violations,
    violationsKnown,
    kpis: computeDayKpis(input.date, input.trips, input.routes, violationsKnown ? violations.length : null),
    skippedVehicles: build.skippedVehicles,
    droppedLocks: build.droppedLocks,
    excludedTrips: build.excludedTrips,
    notes: build.notes,
    staleTrips,
    lastRun: runView(input.lastRun, input.details, input.settings.solverTimeLimitSec, now, patientOf),
    planRun: runView(input.planRun, input.details, input.settings.solverTimeLimitSec, now, patientOf),
    timeRange: computeTimeRange(rows),
    dayStarted:
      input.trips.some((t) => FIELD_STATUSES.includes(t.status)) ||
      input.routes.some((r) => r.stops.some((s) => s.completedAt !== null)),
    timeLimitSec: build.request.settings.timeLimitSec,
  };
}

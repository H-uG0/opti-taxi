/**
 * Serializable view model of the planning page (server -> client components).
 * Minutes are planned times since local midnight; instants are ISO strings.
 */
import type {
  OptimizationRunStatus,
  Payer,
  RouteStatus,
  SharingStatus,
  StopKind,
  TripDirection,
  TripStatus,
  VehicleType,
} from "@prisma/client";
import type { TariffGap } from "@/lib/domain/tariffs";
import type { DroppedLock, ExcludedTrip, SkippedVehicle } from "@/lib/optimizer/build-request";
import type { PlanComparison, PlanFigures } from "./plan-compare";
import type { VehicleIssue } from "./route-issues";

export type LatLngView = { lat: number; lng: number };

export type StopView = {
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
  completed: boolean;
};

export type RouteView = {
  id: string;
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
  validatedAt: string | null;
  tripCount: number;
  stops: StopView[];
};

export type VehicleRowView = {
  id: string;
  label: string;
  registration: string;
  type: VehicleType;
  capacity: number;
  /** Hex color of this vehicle (shade of its type color). */
  color: string;
  depot: LatLngView & { label: string };
  driverName: string | null;
  crewMateName: string | null;
  available: boolean;
  unavailableReason: string | null;
  shift: { start: number; end: number } | null;
  breakWindow: { start: number; end: number; duration: number } | null;
  route: RouteView | null;
};

/**
 * Who recorded something and when: the patient's sharing answer (regulator)
 * or a stop status (crew). `byName` is null when the account is unknown
 * (recorded before the audit trail, or account deleted since).
 */
export type RecordedByView = {
  /** Real instant of the record (ISO). */
  at: string;
  byName: string | null;
};

/** A stop of the trip whose status the crew recorded on the roadmap. */
export type FieldRecordView = RecordedByView & {
  stopId: string;
  kind: StopKind;
};

export type TripView = {
  id: string;
  direction: TripDirection;
  status: TripStatus;
  payer: Payer;
  patientName: string;
  facilityName: string | null;
  pickupAddress: string;
  dropoffAddress: string;
  pickup: LatLngView;
  dropoff: LatLngView;
  appointmentMinute: number | null;
  readyMinute: number | null;
  allowedVehicleTypes: VehicleType[];
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
  /** When and by whom the patient's answer was last recorded; null when none was (kept after a reset, as on /courses). */
  sharingAnswer: RecordedByView | null;
  /** Pick-up (or absence) and drop-off recorded by the crew, in route order; empty before the trip starts. */
  fieldRecords: FieldRecordView[];
  lockedVehicleId: string | null;
  /** Vehicle of the route the trip is in, null when unassigned. */
  vehicleId: string | null;
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
  shared: boolean;
  coPassengerTripIds: string[];
  directKm: number | null;
  detourKm: number | null;
  estimatedRevenue: number | null;
  /** OUTBOUND: RDV - planned drop-off; RETURN: planned pick-up - end of session. */
  waitAtFacilityMin: number | null;
  /**
   * RETURN trip still to do whose outbound leg of the day was closed as
   * "patient absent": call the patient or cancel the return (@/lib/domain/no-show).
   */
  outboundNoShow: boolean;
};

export type UnassignedView = { tripId: string; reason: string };

export type ViolationView = {
  code: string;
  label: string;
  message: string;
  tripId: string | null;
  vehicleId: string | null;
};

/**
 * Indicators of the planned day. Every figure but tripsTotal and violations
 * comes from @/lib/kpis (the dashboard formulas), so /planning and
 * /tableau-de-bord always show the same numbers for a day.
 */
export type DayKpis = {
  /** Trips to plan: every trip of the day except cancelled and absent ones. */
  tripsTotal: number;
  tripsServed: number;
  vehiclesUsed: number;
  tripsPerVehicle: number | null;
  totalKm: number;
  emptyKm: number;
  emptyKmRatio: number | null;
  sharedTrips: number;
  sharedTripRatio: number | null;
  revenue: number;
  margin: number;
  /** null when the count is unknown (run saved without its details). */
  violations: number | null;
};

export type RunView = {
  id: string;
  status: OptimizationRunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** End-to-end duration seen by the regulator. */
  durationMs: number | null;
  /** Solver wall time reported by the optimizer. */
  wallTimeMs: number | null;
  matrixSource: string | null;
  /** What slowed the travel times down ("none", "factors"), null for a run saved before traffic existed. */
  trafficSource: string | null;
  valid: boolean | null;
  error: string | null;
  tripsCount: number;
  lockedCount: number;
  unassignedCount: number;
  requestedBy: string | null;
  /** Optimizer warnings, null when no longer known. */
  warnings: string[] | null;
  /** Solver budget of this run, scaled with the trips it sent (effectiveTimeLimitSec, current setting). */
  timeLimitSec: number;
  /**
   * Still RUNNING long after its budget (isStaleRun): the server stopped
   * during the computation. The next optimization marks it FAILED.
   */
  interrupted: boolean;
  /** « Optimiser », « Déplacer vers… » or « Revenir au planning précédent »; null for a run saved before. */
  kind: "optimize" | "move" | "restore" | null;
  /** AWAITING_CONFIRMATION: the question asked (patients named) and the figures side by side. */
  pending: { question: string; comparison: PlanComparison } | null;
  /** Figures of the routes this run replaced, when they can be brought back (« Revenir au planning précédent »). */
  previous: PlanFigures | null;
  /** When /evaluate last re-checked the plan's violations (a trip left a route), ISO; null if never. */
  evaluatedAt: string | null;
};

/** EMPTY: no trip; UNPLANNED: trips but no route; PROPOSED / VALIDATED: every route in that status; MIXED otherwise. */
export type DayStatus = "EMPTY" | "UNPLANNED" | "PROPOSED" | "VALIDATED" | "MIXED";

export type PlanningDayView = {
  date: string;
  dayStatus: DayStatus;
  /** Timeline rows: vehicles with a route, then available vehicles without one. */
  vehicles: VehicleRowView[];
  /** Every trip of the day that is not cancelled, plus cancelled ones still in a route. */
  trips: TripView[];
  unassigned: UnassignedView[];
  violations: ViolationView[];
  violationsKnown: boolean;
  kpis: DayKpis;
  skippedVehicles: SkippedVehicle[];
  droppedLocks: DroppedLock[];
  excludedTrips: ExcludedTrip[];
  notes: string[];
  /** Available vehicles without tariff grid that day: their revenue is estimated at 0 €. */
  tariffGaps: TariffGap[];
  /** Trips whose state changed after planning (cancelled while still in a route…). */
  staleTrips: UnassignedView[];
  /**
   * Vehicles whose route was planned before a change of vehicle or crew
   * (unavailability, absence, crew changed), or whose inspection or insurance
   * is overdue on the date (lib/planning/route-issues.ts).
   */
  vehicleIssues: VehicleIssue[];
  /** Latest run of any status. */
  lastRun: RunView | null;
  /** Run that produced the current routes (latest successful one). */
  planRun: RunView | null;
  timeRange: { start: number; end: number };
  /** True once a trip was picked up: re-planning is then disabled. */
  dayStarted: boolean;
  /** Solver budget of an optimization launched now, scaled with the trips it would send (effectiveTimeLimitSec). */
  timeLimitSec: number;
};

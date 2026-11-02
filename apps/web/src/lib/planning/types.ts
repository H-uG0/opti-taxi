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
import type { DroppedLock, ExcludedTrip, SkippedVehicle } from "@/lib/optimizer/build-request";

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
};

export type UnassignedView = { tripId: string; reason: string };

export type ViolationView = {
  code: string;
  label: string;
  message: string;
  tripId: string | null;
  vehicleId: string | null;
};

export type DayKpis = {
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
  valid: boolean | null;
  error: string | null;
  tripsCount: number;
  lockedCount: number;
  unassignedCount: number;
  requestedBy: string | null;
  /** Optimizer warnings, null when no longer known. */
  warnings: string[] | null;
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
  /** Trips whose state changed after planning (cancelled while still in a route…). */
  staleTrips: UnassignedView[];
  /** Latest run of any status. */
  lastRun: RunView | null;
  /** Run that produced the current routes (latest successful one). */
  planRun: RunView | null;
  timeRange: { start: number; end: number };
  /** True once a trip was picked up: re-planning is then disabled. */
  dayStarted: boolean;
};

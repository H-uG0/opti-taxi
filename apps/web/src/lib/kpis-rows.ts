/**
 * Input rows of the dashboard indicators (@/lib/kpis and its parts:
 * kpis-demand, kpis-fleet, kpis-sharing, kpis-waits, kpis-plan) and the small
 * helpers they share. Pure module: plain rows, never the database.
 *
 * Every field added after the first version of the dashboard is optional: the
 * planning computes its strip with the same formulas from its own rows
 * (lib/planning/view.ts, filter.ts) and only fills what it shows. An absent
 * field reads as unknown (no payer: CPAM, no sharing right, no timestamp).
 */
import type {
  CancellationReason,
  Payer,
  SharingStatus,
  StopEntrySource,
  StopKind,
  TripDirection,
  TripStatus,
  VehicleType,
} from "@prisma/client";
import { fromIsoDate, isoDateOf, minuteOfDay } from "@/lib/time";

export type KpiRoute = {
  /** Route id: trips point to it (routeId). Absent: the route's vehicle type is unknown to its trips. */
  id?: string;
  /** Service date, "YYYY-MM-DD". */
  serviceDate: string;
  vehicleId: string;
  /** Type of the route's vehicle: the shared rate of the Assurance maladie counts taxis and VSL apart. */
  vehicleType?: VehicleType;
  /** Depot of the vehicle, driver and crew mate of the route: breakdowns (KPI-02). */
  depotId?: string | null;
  driverId?: string | null;
  crewMateId?: string | null;
  /**
   * Planned minutes of the route (end - start, its break taken out), the
   * minutes with a patient on board and those the vehicle waits at a place of
   * care before its stop starts (kpis-load.ts routeTimings): unit economics
   * and planned hours (KPI-02, KPI-10). Absent: unknown.
   */
  activeMinutes?: number;
  /** Minutes the optimizer charges at the hourly cost: end - start, the break included. Absent: activeMinutes. */
  paidMinutes?: number;
  onboardMinutes?: number;
  facilityWaitMinutes?: number;
  distanceKm: number;
  emptyKm: number;
  revenue: number;
  cost: number;
  margin: number;
  validatedAt: Date | null;
  /**
   * Stops still in the route. Cancelling or moving a trip removes its stops
   * but keeps the route row: a route left without stops no longer uses its
   * vehicle (same rule as /planning).
   */
  stopCount: number;
  /** The crew recorded at least one stop status (pickup, drop-off or absence) on this route. */
  hasRecordedStatus: boolean;
  /** Source of its times and km (Route.matrixSource: osrm, haversine, mixed); absent or null: unknown. */
  matrixSource?: string | null;
};

export type KpiTrip = {
  id?: string;
  serviceDate: string;
  status: TripStatus;
  routeId: string | null;
  direction: TripDirection;
  shared: boolean;
  appointmentMinute: number | null;
  plannedDropoffMinute: number | null;
  /** Real drop-off instant entered by the driver (completedAt of the trip's DROPOFF stop). */
  dropoffCompletedAt: Date | null;
  /**
   * A seated trip carried by an ambulance on a regulator's proposal (« recours
   * exceptionnel », billed at the VSL tariff); absent: false.
   */
  exceptionalAmbulance?: boolean;
  /** Patient (id only): refusals per patient, and the two legs of a care session (waits). */
  patientId?: string;
  recurrenceId?: string | null;
  facilityId?: string | null;
  /** Absent: CPAM. */
  payer?: Payer;
  /** Vehicle types the prescription allows: only AMBULANCE is a lying patient. */
  allowedVehicleTypes?: VehicleType[];
  /** The prescription allows sharing this leg (absent: false). */
  sharingAllowed?: boolean;
  sharingStatus?: SharingStatus;
  sharingProposedAt?: Date | null;
  sharingRespondedAt?: Date | null;
  /** RETURN: end of the session (pickup at the earliest). */
  readyMinute?: number | null;
  plannedPickupMinute?: number | null;
  directKm?: number | null;
  detourKm?: number | null;
  /** Estimated invoice of the patient for this leg (last plan), euros. */
  estimatedRevenue?: number | null;
  cancellationReason?: CancellationReason | null;
  cancelledAt?: Date | null;
  /** Real pickup instant entered by the crew (completedAt of the trip's PICKUP stop, « Pris en charge »). */
  pickupCompletedAt?: Date | null;
  /** Planned service time at the pickup stop (departure - start), minutes. */
  pickupServiceMinutes?: number | null;
  /** « Arrivé » at the pickup (RouteStop.arrivedAt, FLD-01): the wait at the door is measured from it. */
  pickupArrivedAt?: Date | null;
  /** Planned start of the pickup stop (minute of the day): the wait at the door never starts before it. */
  pickupStartMinute?: number | null;
  /** Planned time on board: start of the drop-off - departure from the pickup, minutes. */
  plannedRideMinutes?: number | null;
  /**
   * How the pickup's and the drop-off's times were entered (RouteStop.completedSource): null or absent, by the crew
   * on the moment; DECLARED, typed afterwards in « Fin de tournée »; CORRECTED, by the regulation (FLD-02).
   */
  pickupSource?: StopEntrySource | null;
  dropoffSource?: StopEntrySource | null;
};

/**
 * A time entered afterwards (« Fin de tournée », a regulator's correction): it closes the trip but measures nothing,
 * so punctuality and waits leave it out (a forgotten late drop-off typed at its planned time would count on time).
 */
export function enteredAfterwards(source: StopEntrySource | null | undefined): boolean {
  return source === "DECLARED" || source === "CORRECTED";
}

/** The outcome of the trip (its drop-off, or its pickup for an absence) was set by the regulation, not the crew. */
export function outcomeCorrected(trip: Pick<KpiTrip, "status" | "pickupSource" | "dropoffSource">): boolean {
  return (trip.status === "NO_SHOW" ? trip.pickupSource : trip.dropoffSource) === "CORRECTED";
}

/**
 * `simulated`: a run of the history simulation (pnpm db:history), whose day is marked « simulé ».
 * `requestedById`: the account that launched it (the click starts a planning session, kpis-planning-time.ts).
 */
export type KpiRun = { serviceDate: string; startedAt: Date; simulated?: boolean; requestedById?: string | null };

/**
 * A regulator's action on the planning of a date, from the audit trail
 * (AuditEvent with that service date): the planning time is measured from
 * them (kpis-planning-time.ts). Action names as lib/audit.ts writes them.
 */
export type KpiActivity = { serviceDate: string; at: Date; action: string; userId: string | null };

/**
 * Vehicles of a day (ids): active, unavailable (maintenance, on-call duty…)
 * and without a crew (nobody available, a blocking crew problem, or left at
 * the depot by the regulator), as the crews of the day resolve them
 * (lib/staff/day-crews.ts). See kpis-fleet.ts.
 */
export type KpiFleetDay = { serviceDate: string; active: string[]; unavailable: string[]; crewless: string[] };

/** A frozen validated plan (ValidatedPlan row), decoded (kpis-plan.ts). */
export type KpiFrozenPlan = { serviceDate: string; validatedAt: Date; figures: import("./kpis-plan").PlanFigures };

export type KpiData = {
  routes: KpiRoute[];
  trips: KpiTrip[];
  runs: KpiRun[];
  /** Absent: the fleet indicators are unknown (« — »). */
  fleet?: KpiFleetDay[];
  /** Frozen validated plans of the dates that have one. */
  plans?: KpiFrozenPlan[];
  /** Planning actions of the regulators (audit trail); absent: the planning time is unknown (« — »). */
  activity?: KpiActivity[];
  /**
   * The rows were narrowed to a depot or a vehicle type (kpis-scope.ts): the
   * trips left without a vehicle belong to no depot, so the demand-based
   * indicators (service rate, lost trips) are not measured (« — »).
   */
  scoped?: boolean;
};

/** Settings of the indicators: the business rules they are measured against. */
export type KpiOptions = {
  /** An outbound patient is late when dropped off more than this after the appointment (minutes). */
  lateToleranceMin: number;
  /** A planned outbound drop-off closer than this to the appointment is « serré » (minutes). */
  tightMarginMin: number;
  /** Wait at the place of care, before the appointment and after the session, at most (AppSettings.maxTotalWaitMin). */
  maxTotalWaitMin: number;
  /** Time on board at most the direct drive + this (AppSettings.maxRideExtraMin). */
  maxRideExtraMin: number;
  /** Detour per patient added (AppSettings.maxDetourKmPerExtraPatient). */
  maxDetourKm: number;
};

/** The schema defaults of AppSettings, a 5-minute tolerance (the drop-off service time) and a 5-minute margin. */
export const DEFAULT_KPI_OPTIONS: KpiOptions = {
  lateToleranceMin: 5,
  tightMarginMin: 5,
  maxTotalWaitMin: 45,
  maxRideExtraMin: 30,
  maxDetourKm: 10,
};

/** Trips that are in a route and will be (or were) billed. */
export const SERVED_TRIP_STATUSES = ["ASSIGNED", "PICKED_UP", "DROPPED_OFF"] as const satisfies readonly TripStatus[];

const DAY_MS = 86_400_000;

/** numerator / denominator, or null when the denominator is zero. */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Quantile `q` (0..1) of the values, linear interpolation between the two
 * nearest ranks (the median of 1, 2, 3, 4 is 2.5); null when there is none.
 */
export function quantile(values: readonly number[], q: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

/** Mean of the values, null when there is none. */
export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Real instant -> minute of the planned day `serviceDate` (Europe/Paris), so
 * that it compares with planned minutes: a drop-off at 00:10 the next day is
 * minute 1450, not 10.
 */
export function minuteOfServiceDay(instant: Date, serviceDate: string): number {
  const offsetDays = Math.round((fromIsoDate(isoDateOf(instant)).getTime() - fromIsoDate(serviceDate).getTime()) / DAY_MS);
  return offsetDays * 1440 + minuteOfDay(instant);
}

export function isServedTrip(trip: Pick<KpiTrip, "status" | "routeId">): boolean {
  return trip.routeId !== null && (SERVED_TRIP_STATUSES as readonly TripStatus[]).includes(trip.status);
}

export function isRealizedTrip(trip: Pick<KpiTrip, "status" | "routeId">): boolean {
  return trip.routeId !== null && trip.status === "DROPPED_OFF";
}

/** A route that still has stops: its vehicle, km and money count. */
export function isUsedRoute(route: Pick<KpiRoute, "stopCount">): boolean {
  return route.stopCount > 0;
}

/** A lying patient: the prescription allows the ambulance only (an empty list reads as seated). */
export function isLyingTrip(trip: Pick<KpiTrip, "allowedVehicleTypes">): boolean {
  const types = trip.allowedVehicleTypes ?? [];
  return types.length > 0 && types.every((type) => type === "AMBULANCE");
}

/** Vehicle types of the transport assis professionnalisé, counted apart by the Assurance maladie. */
export const TAP_TYPES = ["VSL", "TAXI"] as const satisfies readonly VehicleType[];
export type TapType = (typeof TAP_TYPES)[number];

export function isTapType(type: VehicleType | null | undefined): type is TapType {
  return type === "VSL" || type === "TAXI";
}

/** Stop rows as the loader reads them, for the per-trip timings and the route timings (kpis-load.ts). */
export type KpiStopRow = {
  routeId: string;
  tripId: string;
  kind: StopKind;
  startMinute: number;
  departureMinute: number;
  completedAt: Date | null;
  /** « Arrivé » on a pickup (FLD-01); absent in older callers. */
  arrivedAt?: Date | null;
  /** How its time was entered (FLD-02); absent in older callers: on the moment. */
  completedSource?: StopEntrySource | null;
  /** Absent in older callers: the route timings are then unknown. */
  sequence?: number;
  arrivalMinute?: number;
  loadAfter?: number;
};

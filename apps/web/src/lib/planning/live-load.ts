/**
 * The live state of a planned day (DAY-01, DAY-04, DAY-05), polled by the planning page of today every 30 s
 * (GET /planning/suivi) and read once with the page:
 * - what the crews recorded: each stop's status time, each trip's status and end of session;
 * - the returns to check after an absence on the outbound leg;
 * - where each crew stands with its roadmap (version published, « J'ai vu »);
 * - the crews' requests still to handle (« Fin de séance », « Demande d'annulation »…);
 * - a key of the plan itself (routes, stops, trips, crews), statuses and end-of-session times aside: when it moves,
 *   something else than the field changed the plan, and the page offers « Recharger ».
 * Ids, minutes, statuses, crew names and a request's reason from a fixed list: the read of the day's patients
 * stays the one traced with the page (plan.view).
 *
 * Takes the Prisma client as a parameter (no server-only import), like version.ts.
 */
import { createHash } from "node:crypto";
import type { CancellationReason, FieldRequestKind, FieldRequestStatus, Prisma, PrismaClient, StopKind, TripStatus } from "@prisma/client";
import type { FieldRequestView } from "@/lib/domain/field-requests";
import { returnsToCheckAfterNoShow } from "@/lib/domain/no-show";
import { formatTimeOn, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { minuteOn } from "./day-progress";
import { roadmapSnapshot, roadmapStanding, roadmapStateText, storedStops, type StoredVersion } from "./roadmap-version";
import { loadDayVersion } from "./version";

/** Where a crew stands with its roadmap, as the regulator reads it. */
export type RoadmapStateView = {
  text: string;
  tone: "ok" | "pending" | "info";
  /** Changes not acknowledged by the crew, since (ISO); null when none. */
  pendingSince: string | null;
};

export type LiveSnapshot = {
  date: string;
  /** Server clock (epoch ms): the page's « maintenant » follows it, not the computer's clock. */
  serverTime: number;
  /** Minute of the day of the date at serverTime (Europe/Paris, past midnight after it), null for another day than today. */
  nowMinute: number | null;
  /** Key of the plan, field statuses and end-of-session times aside. */
  planKey: string;
  /** Plan version (lib/planning/version.ts), latest run token and running flag, as /planning/version gives them. */
  version: string;
  run: string | null;
  running: boolean;
  /** Stop id -> minute of its recorded status, for every stop with one. */
  done: Record<string, number>;
  /** Trip id -> status and end of session, for every trip of the day. */
  trips: Record<string, { status: TripStatus; readyMinute: number | null }>;
  /** Returns still to do whose outbound leg was closed as « patient absent ». */
  returnsToCheck: string[];
  /** Vehicle id -> the crew's roadmap state (routes of the day only). */
  roadmaps: Record<string, RoadmapStateView>;
  /** Requests of the crews still to handle, oldest first. */
  requests: FieldRequestView[];
};

type Client = Pick<PrismaClient, "route" | "trip" | "routeVersion" | "fieldRequest" | "$queryRaw" | "optimizationRun" | "appSettings">;

const ROUTE_SELECT = {
  id: true,
  vehicleId: true,
  status: true,
  driverId: true,
  crewMateId: true,
  startMinute: true,
  endMinute: true,
  breakStartMinute: true,
  breakEndMinute: true,
  stops: { select: { id: true, tripId: true, kind: true, sequence: true, startMinute: true, completedAt: true } },
} satisfies Prisma.RouteSelect;

const TRIP_SELECT = {
  id: true,
  status: true,
  direction: true,
  readyMinute: true,
  appointmentMinute: true,
  routeId: true,
  lockedVehicleId: true,
  patientId: true,
  recurrenceId: true,
  facilityId: true,
  payer: true,
  sharingStatus: true,
  pickupAddress: true,
  dropoffAddress: true,
  notes: true,
} satisfies Prisma.TripSelect;

type LiveRoute = Prisma.RouteGetPayload<{ select: typeof ROUTE_SELECT }>;
type LiveTrip = Prisma.TripGetPayload<{ select: typeof TRIP_SELECT }>;

function token(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 16);
}

/**
 * Key of what the page draws of the plan, apart from what the field changes (stop and trip statuses, end of session):
 * each route's crew, status, break and stops with their planned times; each trip's route, lock, cancellation,
 * appointment and what the panel shows of it (patient, addresses, payer, sharing, notes) — hashed, never sent.
 */
export function planKeyOf(routes: readonly LiveRoute[], trips: readonly LiveTrip[]): string {
  const routeText = [...routes]
    .sort((a, b) => a.vehicleId.localeCompare(b.vehicleId))
    .map((route) =>
      [
        route.vehicleId,
        route.status,
        route.driverId ?? "",
        route.crewMateId ?? "",
        route.breakStartMinute ?? "",
        route.breakEndMinute ?? "",
        [...route.stops]
          .sort((a, b) => a.sequence - b.sequence)
          .map((stop) => `${stop.tripId}/${stop.kind}@${stop.startMinute}`)
          .join(","),
      ].join(":"),
    )
    .join("|");
  const tripText = [...trips]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((trip) =>
      [
        trip.id,
        trip.routeId ?? "",
        trip.status === "CANCELLED" ? "x" : "",
        trip.lockedVehicleId ?? "",
        trip.appointmentMinute ?? "",
        trip.patientId,
        trip.payer,
        trip.sharingStatus,
        trip.pickupAddress,
        trip.dropoffAddress,
        trip.notes ?? "",
      ].join(":"),
    )
    .join("|");
  return token(`${routeText}#${tripText}`);
}

const VERSION_SELECT = {
  vehicleId: true,
  version: true,
  fingerprint: true,
  stops: true,
  publishedAt: true,
  seenAt: true,
  seenBy: { select: { name: true } },
} satisfies Prisma.RouteVersionSelect;

type VersionRow = {
  vehicleId: string;
  version: number;
  fingerprint: string;
  stops: Prisma.JsonValue;
  publishedAt: Date;
  seenAt: Date | null;
  seenBy: { name: string } | null;
};

/** Each route's roadmap state: its versions against the roadmap as stored now. */
export function roadmapStatesOf(args: {
  isoDate: string;
  routes: readonly { vehicleId: string; stops: readonly { tripId: string; kind: StopKind; sequence: number; startMinute: number }[] }[];
  cancelled: (tripId: string) => boolean;
  versions: readonly VersionRow[];
  now: Date;
}): Record<string, RoadmapStateView> {
  const { isoDate, routes, cancelled, versions, now } = args;
  const byVehicle = new Map<string, StoredVersion[]>();
  for (const row of versions) {
    const list = byVehicle.get(row.vehicleId) ?? [];
    list.push({ version: row.version, fingerprint: row.fingerprint, stops: storedStops(row.stops), publishedAt: row.publishedAt, seenAt: row.seenAt, seenByName: row.seenBy?.name ?? null });
    byVehicle.set(row.vehicleId, list);
  }
  const states: Record<string, RoadmapStateView> = {};
  for (const route of routes) {
    const standing = roadmapStanding(byVehicle.get(route.vehicleId) ?? []);
    const current = roadmapSnapshot(route.stops, cancelled).fingerprint;
    const state = roadmapStateText({
      standing,
      undelivered: standing !== null && standing.latest.fingerprint !== current,
      time: (instant) => formatTimeOn(instant, isoDate, now),
    });
    if (!state) continue;
    states[route.vehicleId] = { ...state, pendingSince: standing?.changedAt?.toISOString() ?? null };
  }
  return states;
}

const REQUEST_SELECT = {
  id: true,
  kind: true,
  status: true,
  tripId: true,
  readyMinute: true,
  previousReadyMinute: true,
  cancellationReason: true,
  nextSessionDate: true,
  createdAt: true,
  createdBy: { select: { name: true } },
} satisfies Prisma.FieldRequestSelect;

type RequestRow = {
  id: string;
  kind: FieldRequestKind;
  status: FieldRequestStatus;
  tripId: string;
  readyMinute: number | null;
  previousReadyMinute: number | null;
  cancellationReason: CancellationReason | null;
  nextSessionDate: Date | null;
  createdAt: Date;
  createdBy: { name: string } | null;
};

export function fieldRequestView(row: RequestRow): FieldRequestView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    tripId: row.tripId,
    readyMinute: row.readyMinute,
    previousReadyMinute: row.previousReadyMinute,
    cancellationReason: row.cancellationReason,
    nextSessionDate: row.nextSessionDate ? toIsoDate(row.nextSessionDate) : null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy?.name ?? null,
  };
}

/** The crews' requests of isoDate still to handle, oldest first. */
export async function loadPendingRequests(client: Pick<PrismaClient, "fieldRequest">, isoDate: string): Promise<FieldRequestView[]> {
  const rows = await client.fieldRequest.findMany({
    where: { serviceDate: fromIsoDate(isoDate), status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: REQUEST_SELECT,
  });
  return rows.map(fieldRequestView);
}

/** The roadmap states of isoDate's routes (the planning page of tomorrow, without the live poll). */
export async function loadRoadmapStates(client: Pick<PrismaClient, "route" | "trip" | "routeVersion">, isoDate: string, now: Date = new Date()): Promise<Record<string, RoadmapStateView>> {
  const serviceDate = fromIsoDate(isoDate);
  const [routes, cancelled, versions] = await Promise.all([
    client.route.findMany({ where: { serviceDate }, select: { vehicleId: true, stops: { select: { tripId: true, kind: true, sequence: true, startMinute: true } } } }),
    client.trip.findMany({ where: { serviceDate, status: "CANCELLED", routeId: { not: null } }, select: { id: true } }),
    client.routeVersion.findMany({ where: { serviceDate }, select: VERSION_SELECT }),
  ]);
  const gone = new Set(cancelled.map((t) => t.id));
  return roadmapStatesOf({ isoDate, routes, cancelled: (id) => gone.has(id), versions, now });
}

/** The live state of isoDate at `now` (see the module's comment). */
export async function loadLiveSnapshot(client: Client, isoDate: string, now: Date = new Date()): Promise<LiveSnapshot> {
  const serviceDate = fromIsoDate(isoDate);
  const [day, routes, trips, versions, requests] = await Promise.all([
    loadDayVersion(client, isoDate, now),
    client.route.findMany({ where: { serviceDate }, select: ROUTE_SELECT }),
    client.trip.findMany({ where: { serviceDate }, select: TRIP_SELECT }),
    client.routeVersion.findMany({ where: { serviceDate }, select: VERSION_SELECT }),
    loadPendingRequests(client, isoDate),
  ]);
  const done: Record<string, number> = {};
  for (const route of routes) {
    for (const stop of route.stops) if (stop.completedAt) done[stop.id] = minuteOn(stop.completedAt, isoDate);
  }
  const statusOf = new Map(trips.map((trip) => [trip.id, trip.status]));
  return {
    date: isoDate,
    serverTime: now.getTime(),
    nowMinute: isoDate === todayIso(now) ? minuteOn(now, isoDate) : null,
    planKey: planKeyOf(routes, trips),
    version: day.version,
    run: day.run,
    running: day.running,
    done,
    trips: Object.fromEntries(trips.map((trip) => [trip.id, { status: trip.status, readyMinute: trip.readyMinute }])),
    returnsToCheck: [...returnsToCheckAfterNoShow(trips)],
    roadmaps: roadmapStatesOf({ isoDate, routes, cancelled: (id) => statusOf.get(id) === "CANCELLED", versions, now }),
    requests,
  };
}

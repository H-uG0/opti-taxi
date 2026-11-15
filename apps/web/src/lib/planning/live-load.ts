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
import type { CancellationReason, FieldRequestKind, FieldRequestStatus, Prisma, PrismaClient, StopKind, TripDirection, TripStatus } from "@prisma/client";
import type { FieldRequestView } from "@/lib/domain/field-requests";
import { returnsToCheckAfterNoShow } from "@/lib/domain/no-show";
import { formatTimeOn, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { minuteOn } from "./day-progress";
import {
  changedTripIds,
  publicationTime,
  roadmapPending,
  roadmapSnapshot,
  roadmapStanding,
  roadmapStateText,
  seenByCrew,
  storedStops,
  type StoredVersion,
} from "./roadmap-version";
import { loadDayVersion, loadPlanVersion } from "./version";

/** Where a crew stands with its roadmap, as the regulator reads it. */
export type RoadmapStateView = {
  text: string;
  tone: "ok" | "pending" | "info";
  /** When the latest change not acknowledged by the crew (or not received by its phone) was made (ISO); null when none. */
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
  updatedAt: true,
  stops: { select: { id: true, tripId: true, kind: true, sequence: true, startMinute: true, completedAt: true } },
} satisfies Prisma.RouteSelect;

const TRIP_SELECT = {
  id: true,
  status: true,
  direction: true,
  readyMinute: true,
  updatedAt: true,
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

/** planKeyOf of isoDate's plan as stored (usable inside a transaction). */
export async function loadPlanKey(
  client: Pick<PrismaClient, "route" | "trip"> | Pick<Prisma.TransactionClient, "route" | "trip">,
  isoDate: string,
): Promise<string> {
  const serviceDate = fromIsoDate(isoDate);
  const [routes, trips] = await Promise.all([
    client.route.findMany({ where: { serviceDate }, select: ROUTE_SELECT }),
    client.trip.findMany({ where: { serviceDate }, select: TRIP_SELECT }),
  ]);
  return planKeyOf(routes, trips);
}

const LIVE_TOKEN = "live:";

/** What the planning page of today guards its actions with: the plan's key it was drawn with (« Suivi du jour »). */
export function livePlanToken(planKey: string): string {
  return `${LIVE_TOKEN}${planKey}`;
}

/**
 * Whether the plan an action was taken on (`shown`) is still the one stored: the plan version (version.ts), or on the
 * planning page of today its plan key (livePlanToken). The crews' statuses and ends of session move the version
 * all day long but not the key: the page shows them live, and says « Planning modifié » only when the key moves.
 */
export async function shownPlanHolds(
  client: Pick<PrismaClient, "route" | "trip" | "$queryRaw"> | Pick<Prisma.TransactionClient, "route" | "trip" | "$queryRaw">,
  isoDate: string,
  shown: unknown,
): Promise<boolean> {
  if (typeof shown !== "string") return false;
  if (shown.startsWith(LIVE_TOKEN)) return isoDate === todayIso() && livePlanToken(await loadPlanKey(client, isoDate)) === shown;
  return (await loadPlanVersion(client, isoDate)) === shown;
}

const VERSION_SELECT = {
  vehicleId: true,
  version: true,
  fingerprint: true,
  stops: true,
  publishedAt: true,
  seenAt: true,
  seenBy: { select: { name: true, driverId: true } },
} satisfies Prisma.RouteVersionSelect;

type VersionRow = {
  vehicleId: string;
  version: number;
  fingerprint: string;
  stops: Prisma.JsonValue;
  publishedAt: Date;
  seenAt: Date | null;
  seenBy: { name: string; driverId: string | null } | null;
};

/**
 * The versions of isoDate's roadmaps where the crews stand: for each vehicle, its latest version acknowledged and the
 * later ones (the earlier ones tell nothing more, and they pile up through the day). All of them for a vehicle whose
 * versions were never acknowledged (a race of the first opening).
 */
async function loadStandingVersions(client: Pick<PrismaClient, "routeVersion">, serviceDate: Date): Promise<VersionRow[]> {
  const seen = await client.routeVersion.groupBy({ by: ["vehicleId"], where: { serviceDate, seenAt: { not: null } }, _max: { version: true } });
  const from = seen.flatMap((row) => (row._max.version !== null ? [{ vehicleId: row.vehicleId, version: { gte: row._max.version } }] : []));
  return client.routeVersion.findMany({
    where: { serviceDate, OR: [...from, { vehicleId: { notIn: from.map((row) => row.vehicleId) } }] },
    select: VERSION_SELECT,
  });
}

/** A route as its roadmap state needs it: the crew, the stops, and when it was last changed. */
type RoadmapRoute = {
  vehicleId: string;
  driverId: string | null;
  crewMateId: string | null;
  updatedAt: Date;
  stops: readonly { tripId: string; kind: StopKind; sequence: number; startMinute: number }[];
};

/** Each route's roadmap state: its versions against the roadmap as stored now. */
export function roadmapStatesOf(args: {
  isoDate: string;
  routes: readonly RoadmapRoute[];
  trips: ReadonlyMap<string, { status: TripStatus; direction: TripDirection; readyMinute: number | null; updatedAt: Date }>;
  versions: readonly VersionRow[];
  now: Date;
}): Record<string, RoadmapStateView> {
  const { isoDate, routes, trips, versions, now } = args;
  const byVehicle = new Map<string, StoredVersion[]>();
  for (const row of versions) {
    const list = byVehicle.get(row.vehicleId) ?? [];
    list.push({
      version: row.version,
      fingerprint: row.fingerprint,
      stops: storedStops(row.stops),
      publishedAt: row.publishedAt,
      seenAt: row.seenAt,
      seenByName: row.seenBy?.name ?? null,
      seenByDriverId: row.seenBy?.driverId ?? null,
    });
    byVehicle.set(row.vehicleId, list);
  }
  const states: Record<string, RoadmapStateView> = {};
  for (const route of routes) {
    const standing = roadmapStanding(byVehicle.get(route.vehicleId) ?? [], seenByCrew(route));
    const current = roadmapSnapshot(
      route.stops,
      (tripId) => trips.get(tripId)?.status === "CANCELLED",
      (tripId) => {
        const trip = trips.get(tripId);
        return trip?.direction === "RETURN" ? trip.readyMinute : null;
      },
    );
    // A change the phone has not received yet: dated as the phone will date it (roadmap-sync.ts).
    const pending = roadmapPending(standing, current, () =>
      publicationTime({
        previous: standing?.latest.publishedAt ?? null,
        noticedAt: now,
        updates: [route.updatedAt, ...changedTripIds(standing?.latest.stops ?? [], current.stops).flatMap((id) => trips.get(id)?.updatedAt ?? [])],
      }),
    );
    const state = roadmapStateText({ standing, pending, time: (instant) => formatTimeOn(instant, isoDate, now) });
    states[route.vehicleId] = { ...state, pendingSince: pending?.changedAt.toISOString() ?? null };
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
  const [routes, trips, versions] = await Promise.all([
    client.route.findMany({
      where: { serviceDate },
      select: {
        vehicleId: true,
        driverId: true,
        crewMateId: true,
        updatedAt: true,
        stops: { select: { tripId: true, kind: true, sequence: true, startMinute: true } },
      },
    }),
    client.trip.findMany({ where: { serviceDate }, select: { id: true, status: true, direction: true, readyMinute: true, updatedAt: true } }),
    loadStandingVersions(client, serviceDate),
  ]);
  return roadmapStatesOf({ isoDate, routes, trips: new Map(trips.map((t) => [t.id, t])), versions, now });
}

/** The live state of isoDate at `now` (see the module's comment). */
export async function loadLiveSnapshot(client: Client, isoDate: string, now: Date = new Date()): Promise<LiveSnapshot> {
  const serviceDate = fromIsoDate(isoDate);
  const [day, routes, trips, versions, requests] = await Promise.all([
    loadDayVersion(client, isoDate, now),
    client.route.findMany({ where: { serviceDate }, select: ROUTE_SELECT }),
    client.trip.findMany({ where: { serviceDate }, select: TRIP_SELECT }),
    loadStandingVersions(client, serviceDate),
    loadPendingRequests(client, isoDate),
  ]);
  const done: Record<string, number> = {};
  for (const route of routes) {
    for (const stop of route.stops) if (stop.completedAt) done[stop.id] = minuteOn(stop.completedAt, isoDate);
  }
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
    roadmaps: roadmapStatesOf({ isoDate, routes, trips: new Map(trips.map((trip) => [trip.id, trip])), versions, now }),
    requests,
  };
}

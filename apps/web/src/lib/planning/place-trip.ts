/**
 * « Où placer cette course ? » end to end (INS-01): the places of one trip in the routes in place,
 * computed by the optimizer's POST /insert, and « Appliquer », which saves one of them. Shared by
 * the planning server actions (callers check auth).
 *
 * Unlike « Déplacer vers… » (lock, then re-optimize the day: run-optimization.ts), nothing else of the day
 * moves: only the target route and, for a move, the source route are rewritten, with the times,
 * totals and trip results the optimizer computed for them; the trip is locked on its new vehicle
 * (a later optimization keeps it there). The places are computed on the plan of a version
 * (version.ts); « Appliquer » computes the chosen one again on the data of the moment and writes it
 * under the planning lock of the date, only if that version is still the one shown, no computation
 * of the date runs, and the two routes are as read. On a validated or started day it asks first
 * (the drivers' roadmaps change at once; the stops that stay keep their ids, so a status sent from a
 * phone still finds its stop); a route under way is never changed, and on today's date a place
 * whose times are already past is refused. Never on a day without routes (one trip placed there
 * would make a half-planned day), nor for a trip in an exceptional ambulance; a route created
 * never takes people still on another route of the date (one vehicle a day).
 */
import "server-only";
import type { Prisma, RouteStatus, TripStatus } from "@prisma/client";
import { z } from "zod";
import { audit, type AuditActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { buildOptimizeRequest, loadOptimizeInput, personName, type BuildResult, type OptimizeInput } from "@/lib/optimizer/build-request";
import { insert } from "@/lib/optimizer/client";
import { violationSchema, type InsertOption } from "@/lib/optimizer/contract";
import type { CurrentTrip, VehicleCrew } from "@/lib/optimizer/persist";
import { formatLongDate, fromIsoDate, minuteOfDay, todayIso, toIsoDate } from "@/lib/time";
import { lockPlanningDay } from "./day-lock";
import { isExceptionalAmbulanceTrip } from "./exceptional-ambulance";
import {
  buildInsertRequest,
  newRouteStatus,
  pastPlaceReason,
  placedMessage,
  placeQuestion,
  placesView,
  planPlaceWrite,
  planStopWrites,
  type PlaceWrite,
  ROUTE_HOLD_REASONS,
  routeHold,
  violationsAfterPlace,
  type RouteHold,
  type StoredPlaceRoute,
} from "./insertion";
import type { TodayCrew } from "./plan-compare";
import {
  PLACE_EXCEPTIONAL_AMBULANCE,
  PLACE_NO_ROUTES,
  unavailableReason,
  type PlaceRejectionView,
  type PlacesView,
} from "./place-view";
import { isDayStarted } from "./refresh-routes";
import { optimizationInProgress, OPTIMIZATION_IN_PROGRESS_ERROR, PLANNING_TX_OPTIONS, withdrawLapsedProposals } from "./run-optimization";
import { loadPlanVersion } from "./version";

export type FindPlacesOutcome = { ok: true; view: PlacesView } | { ok: false; error: string; stale?: boolean };

export type PlaceOutcome =
  | { ok: true; message: string; warning?: boolean }
  | { ok: false; error: string; needsConfirmation?: boolean; stale?: boolean };

export const PLACES_STALE_ERROR =
  "Le planning a changé depuis la recherche des places\u00a0: relancez «\u202fOù placer cette course\u202f?\u202f».";

const storedRouteSelect = {
  id: true,
  vehicleId: true,
  status: true,
  driverId: true,
  crewMateId: true,
  stops: { select: { id: true, tripId: true, kind: true, sequence: true, completedAt: true } },
} satisfies Prisma.RouteSelect;

/** A date's plan as « Où placer » and the draft read it: the request, the stored routes, which ones must not change. */
export type PlaceDay = {
  isoDate: string;
  /** Version of the plan read before anything else: what the places are computed on. */
  version: string;
  input: OptimizeInput;
  build: BuildResult;
  stored: StoredPlaceRoute[];
  /** Routes the assistant must not change, by vehicle. */
  held: Map<string, RouteHold>;
  /**
   * Vehicles without a route whose crew of the day is still on another vehicle's stored route (crews
   * saved after the plan: « Véhicules à revoir »), with that vehicle's label: a route created for them
   * would put one person on two vehicles.
   */
  crewTaken: Map<string, string>;
  validated: boolean;
  started: boolean;
};

type Prepared = PlaceDay & {
  trip: { id: string; patientName: string; lockedVehicleId: string | null };
  source: StoredPlaceRoute | null;
};

/**
 * Why `tripId` cannot be placed on `day` by the assistant or the draft (null: it can): an
 * exceptional ambulance, incomplete, no longer sent, or on a route that must not change.
 */
export function tripPlaceIssue(day: PlaceDay, tripId: string): { error: string; stale?: boolean } | null {
  const { input, build } = day;
  const raw = input.trips.find((t) => t.id === tripId);
  if (raw && isExceptionalAmbulanceTrip(raw, (id) => input.vehicles.find((v) => v.id === id)?.type)) {
    return { error: PLACE_EXCEPTIONAL_AMBULANCE };
  }
  const excluded = build.excludedTrips.find((t) => t.tripId === tripId);
  if (excluded) return { error: `Course incomplète (${excluded.reason.replace(/[.\s]+$/, "")})\u00a0: complétez-la dans Courses avant de la placer.` };
  if (!build.request.trips.some((t) => t.id === tripId)) return { error: "Cette course n'est plus à planifier (annulée entre-temps\u202f?).", stale: true };
  const source = day.stored.find((route) => route.stops.some((stop) => stop.tripId === tripId)) ?? null;
  const sourceHold = source ? day.held.get(source.vehicleId) : undefined;
  if (source && sourceHold) {
    const skipped = build.skippedVehicles.find((v) => v.vehicleId === source.vehicleId);
    const label = build.request.vehicles.find((v) => v.id === source.vehicleId)?.label ?? skipped?.label ?? "Son véhicule";
    const why =
      sourceHold === "UNAVAILABLE"
        ? `${unavailableReason({ unavailableReason: skipped?.reason ?? null })}. L'assistant ne refait pas la tournée d'un véhicule indisponible\u00a0: seule une réoptimisation de la journée la reprend`
        : ROUTE_HOLD_REASONS[sourceHold];
    return { error: `Cette course ne peut pas quitter sa tournée\u00a0: ${label} ${why}.` };
  }
  return null;
}

/**
 * The plan of `isoDate` as the assistant and the draft read it (null error: a day without routes,
 * planned by « Optimiser », never one trip at a time). The version is read first: a change made
 * after it makes « Appliquer » see another version (never the other way round).
 */
export async function loadPlaceDay(isoDate: string): Promise<{ ok: true; day: PlaceDay } | { ok: false; error: string }> {
  const version = await loadPlanVersion(db, isoDate);
  const [input, stored] = await Promise.all([
    loadOptimizeInput(db, isoDate),
    db.route.findMany({ where: { serviceDate: fromIsoDate(isoDate) }, select: storedRouteSelect }),
  ]);
  if (stored.length === 0) return { ok: false, error: PLACE_NO_ROUTES };
  const build = buildOptimizeRequest(input);
  const sent = new Set(build.request.trips.map((t) => t.id));
  const statuses = new Map<string, TripStatus>(input.trips.map((t) => [t.id, t.status]));
  const types = new Map(build.request.vehicles.map((v) => [v.id, v.type]));
  const todayCrews = new Map<string, TodayCrew>(
    [...build.crews].map(([vehicleId, crew]) => [
      vehicleId,
      types.get(vehicleId) === "AMBULANCE" ? { driverId: crew.driverId, crewMateId: crew.crewMateId } : { driverId: crew.driverId },
    ]),
  );
  const held = new Map<string, RouteHold>();
  for (const route of stored) {
    const hold = routeHold(route, sent, (id) => statuses.get(id), todayCrews);
    if (hold) held.set(route.vehicleId, hold);
  }
  // One person, one vehicle a day: who is on a stored route, and the vehicles without a route whose crew of the day
  // still is (a route created for them would put that person on two vehicles).
  const onRoute = new Map<string, string>();
  for (const route of stored) {
    for (const person of [route.driverId, route.crewMateId]) if (person) onRoute.set(person, route.vehicleId);
  }
  const vehicleLabel = (id: string) =>
    build.request.vehicles.find((v) => v.id === id)?.label ?? build.skippedVehicles.find((v) => v.vehicleId === id)?.label ?? "un autre véhicule";
  const routed = new Set(stored.map((route) => route.vehicleId));
  const crewTaken = new Map<string, string>();
  for (const vehicle of build.request.vehicles) {
    if (routed.has(vehicle.id)) continue;
    const elsewhere = crewOf(build, vehicle.id).map((person) => onRoute.get(person)).find((id) => id !== undefined);
    if (elsewhere !== undefined) crewTaken.set(vehicle.id, vehicleLabel(elsewhere));
  }
  return {
    ok: true,
    day: {
      isoDate,
      version,
      input,
      build,
      stored,
      held,
      crewTaken,
      validated: stored.some((route) => route.status === "VALIDATED"),
      started: isDayStarted(stored, input.trips.map((t) => t.status)),
    },
  };
}

/** The day of the trip, read for the assistant, or why it cannot be placed now. */
async function prepare(tripId: string): Promise<{ ok: true; prepared: Prepared } | { ok: false; error: string; stale?: boolean }> {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    select: { id: true, serviceDate: true, status: true, lockedVehicleId: true, patient: { select: { firstName: true, lastName: true } } },
  });
  if (!trip) return { ok: false, error: "Course introuvable (supprimée entre-temps\u202f?).", stale: true };
  if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") {
    return { ok: false, error: "Cette course est annulée\u00a0: elle ne se place plus dans une tournée." };
  }
  if (trip.status === "PICKED_UP" || trip.status === "DROPPED_OFF") return { ok: false, error: "Cette course est déjà commencée ou terminée." };
  const isoDate = toIsoDate(trip.serviceDate);
  if (isoDate < todayIso()) return { ok: false, error: `Le ${formatLongDate(isoDate)} est passé\u00a0: son planning n'est plus modifiable.` };
  const loaded = await loadPlaceDay(isoDate);
  if (!loaded.ok) return loaded;
  const { day } = loaded;
  const issue = tripPlaceIssue(day, trip.id);
  if (issue) return { ok: false, ...issue };
  return {
    ok: true,
    prepared: {
      ...day,
      trip: { id: trip.id, patientName: personName(trip.patient), lockedVehicleId: trip.lockedVehicleId },
      source: day.stored.find((route) => route.stops.some((stop) => stop.tripId === trip.id)) ?? null,
    },
  };
}

/** People a route of the vehicle gets (persist.ts): its driver of the day and, for an ambulance, its crew mate. */
export function crewOf(build: BuildResult, vehicleId: string): string[] {
  const crew = build.crews.get(vehicleId);
  if (!crew) return [];
  const ambulance = build.request.vehicles.find((v) => v.id === vehicleId)?.type === "AMBULANCE";
  return [crew.driverId, ...(ambulance && crew.crewMateId ? [crew.crewMateId] : [])].filter((id) => id !== "");
}

/** « a son équipage du jour encore sur la tournée de Taxi 5 (voir « À traiter ») ». */
export function crewTakenReason(otherLabel: string): string {
  return `a son équipage du jour encore sur la tournée de ${otherLabel} (voir «\u202fÀ traiter\u202f»)`;
}

/** The vehicles to send to /insert: every one but those whose route is held or whose crew is taken (null: every one). */
function triedVehicles(prepared: Prepared): string[] | null {
  if (prepared.held.size === 0 && prepared.crewTaken.size === 0) return null;
  return prepared.build.request.vehicles.map((v) => v.id).filter((id) => !prepared.held.has(id) && !prepared.crewTaken.has(id));
}

/** The minute of the day now in Europe/Paris when isoDate is today, null for a later date. */
export function nowMinuteOn(isoDate: string, now: Date = new Date()): number | null {
  return isoDate === todayIso(now) ? minuteOfDay(now) : null;
}

/** « Où placer cette course ? »: the places of the trip in the routes in place, nothing written. */
export async function findTripPlaces(tripId: string): Promise<FindPlacesOutcome> {
  const began = Date.now();
  const ready = await prepare(tripId);
  if (!ready.ok) return ready;
  const { prepared } = ready;
  const { request } = prepared.build;
  const result = await insert(buildInsertRequest(request, prepared.stored, tripId, triedVehicles(prepared)));
  if (!result.ok) return { ok: false, error: result.error };
  const allowed = request.trips.find((t) => t.id === tripId)?.allowedVehicleTypes ?? [];
  const held: PlaceRejectionView[] = request.vehicles
    .filter((v) => (prepared.held.has(v.id) || prepared.crewTaken.has(v.id)) && allowed.includes(v.type) && v.id !== prepared.source?.vehicleId)
    .map((v) => {
      const hold = prepared.held.get(v.id);
      if (!hold) return { vehicleId: v.id, kind: "RULES", reason: crewTakenReason(prepared.crewTaken.get(v.id) ?? "un autre véhicule") };
      return { vehicleId: v.id, kind: hold === "STARTED" ? "STARTED" : "RULES", reason: ROUTE_HOLD_REASONS[hold] };
    });
  // Today: the optimizer times the routes from the start of the shift, unaware of the hour.
  const nowMinute = nowMinuteOn(prepared.isoDate);
  const past: PlaceRejectionView[] =
    nowMinute === null
      ? []
      : result.data.options.flatMap((option) => {
          const reason = pastPlaceReason(option, nowMinute);
          return reason ? [{ vehicleId: option.vehicleId, kind: "PAST" as const, reason }] : [];
        });
  const view = placesView(result.data, [...held, ...past], prepared.version, Date.now() - began);
  console.info(
    `[planning] places of a trip on ${prepared.isoDate}: ${view.options.length} option(s), ${view.rejected.length} without, ` +
      `${view.elapsedMs} ms (optimizer ${result.data.meta.wallTimeMs} ms)`,
  );
  return { ok: true, view };
}

/** The plan run's stored violations and unassigned trips once the option is saved (its routes re-checked). */
async function updatePlanRun(
  tx: Prisma.TransactionClient,
  isoDate: string,
  option: InsertOption,
  fromVehicleId: string | null,
  prepared: Prepared,
): Promise<string | null> {
  const run = await tx.optimizationRun.findFirst({
    where: { serviceDate: fromIsoDate(isoDate), status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { id: true, details: true },
  });
  if (!run) return null;
  const details = run.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return run.id;
  const parsed = z.array(violationSchema).safeParse(details.violations);
  const stored = parsed.success ? parsed.data : [];
  const violations = violationsAfterPlace(stored, option, fromVehicleId, prepared.build.request);
  const unassigned = Array.isArray(details.unassigned)
    ? details.unassigned.filter((u) => !(u && typeof u === "object" && !Array.isArray(u) && u.tripId === prepared.trip.id))
    : details.unassigned;
  await tx.optimizationRun.update({
    where: { id: run.id },
    data: {
      valid: violations.length === 0,
      details: { ...details, violations, ...(unassigned !== undefined ? { unassigned } : {}) } as Prisma.InputJsonObject,
    },
  });
  return run.id;
}

/**
 * Writes the routes of a placement (« Appliquer ») or of the draft: each route kept is updated in
 * place, the stops that stay keeping their ids (planStopWrites: a driver's phone names them by id,
 * roadmap and offline queue); a route created takes the day's status (and its validation time) and
 * the crew of its row; the trips of these routes get their results and route; `locks` sets the lock
 * of the trips the regulator moved (null: unlocked); the routes left without a stop are deleted.
 * Run inside the transaction holding the planning lock and the routes' row locks.
 */
export async function writePlacedRoutes(
  tx: Prisma.TransactionClient,
  args: {
    serviceDate: Date;
    write: PlaceWrite;
    storedByVehicle: ReadonlyMap<string, StoredPlaceRoute>;
    matrixSource: string;
    status: RouteStatus;
    validatedAt: Date;
    planRunId: string | null;
    locks: ReadonlyMap<string, string | null>;
  },
): Promise<void> {
  const { serviceDate, write, storedByVehicle, matrixSource, status, validatedAt, planRunId, locks } = args;
  const routeIdByVehicle = new Map<string, string>();
  for (const { routeId, row } of write.routes) {
    const { stops, vehicleId: rowVehicle, driverId, crewMateId, ...totals } = row;
    if (routeId) {
      // The stops that stay are updated in place: a driver's phone names them by id (roadmap, offline queue).
      const stopWrites = planStopWrites(storedByVehicle.get(rowVehicle)?.stops ?? [], stops);
      if (stopWrites.deleteIds.length > 0) await tx.routeStop.deleteMany({ where: { id: { in: stopWrites.deleteIds } } });
      if (stopWrites.updates.length > 0) {
        // Out of the way first (-1, -2…): each stop then takes its new position, never one another still holds
        // (@@unique([routeId, sequence]) is checked row by row).
        await tx.$executeRaw`UPDATE "RouteStop" SET "sequence" = -"sequence" - 1 WHERE "routeId" = ${routeId}`;
        for (const { id, data } of stopWrites.updates) await tx.routeStop.update({ where: { id }, data });
      }
      await tx.route.update({ where: { id: routeId }, data: { ...totals, matrixSource } });
      if (stopWrites.creates.length > 0) {
        await tx.routeStop.createMany({ data: stopWrites.creates.map((stop) => ({ ...stop, routeId })) });
      }
      routeIdByVehicle.set(rowVehicle, routeId);
    } else {
      const created = await tx.route.create({
        data: {
          ...totals,
          vehicleId: rowVehicle,
          driverId,
          crewMateId,
          serviceDate,
          status,
          ...(status === "VALIDATED" ? { validatedAt } : {}),
          optimizationRunId: planRunId,
          matrixSource,
          stops: { createMany: { data: stops } },
        },
        select: { id: true },
      });
      routeIdByVehicle.set(rowVehicle, created.id);
    }
  }
  for (const update of write.trips) {
    await tx.trip.update({
      where: { id: update.tripId },
      data: {
        ...update.data,
        routeId: update.vehicleId ? (routeIdByVehicle.get(update.vehicleId) ?? null) : null,
        ...(locks.has(update.tripId) ? { lockedVehicleId: locks.get(update.tripId) ?? null } : {}),
      },
    });
  }
  if (write.deletedRouteIds.length > 0) await tx.route.deleteMany({ where: { id: { in: write.deletedRouteIds } } });
}

/**
 * « Appliquer » : the trip goes to `vehicleId` at the best place /insert finds now, on the version
 * of the plan the regulator saw the places of (`shownVersion`). `confirmed`: the question answered
 * on a validated or started day (asked again when it changed).
 */
export async function applyTripPlace(
  tripId: string,
  vehicleId: string,
  shownVersion: string,
  confirmed: string | null,
  user: AuditActor,
): Promise<PlaceOutcome> {
  const ready = await prepare(tripId);
  if (!ready.ok) return ready;
  const { prepared } = ready;
  const { isoDate, build, source } = prepared;
  if (prepared.version !== shownVersion) return { ok: false, error: PLACES_STALE_ERROR, stale: true };
  const labelOf = (id: string) => build.request.vehicles.find((v) => v.id === id)?.label ?? null;
  const targetLabel = labelOf(vehicleId);
  if (!targetLabel) return { ok: false, error: "Ce véhicule n'est plus disponible ce jour\u00a0: relancez «\u202fOù placer cette course\u202f?\u202f».", stale: true };
  const hold = prepared.held.get(vehicleId);
  if (hold) return { ok: false, error: `Place refusée\u00a0: ${targetLabel} ${ROUTE_HOLD_REASONS[hold]}.` };
  const taken = prepared.crewTaken.get(vehicleId);
  if (taken !== undefined) return { ok: false, error: `Place refusée\u00a0: ${targetLabel} ${crewTakenReason(taken)}.` };
  if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

  const fromVehicleId = source?.vehicleId ?? null;
  if (fromVehicleId === vehicleId) return { ok: false, error: `La course est déjà sur ${targetLabel}.`, stale: true };
  const fromLabel = fromVehicleId ? (labelOf(fromVehicleId) ?? "son véhicule") : null;
  const question = placeQuestion({ validated: prepared.validated, started: prepared.started }, [targetLabel, ...(fromLabel ? [fromLabel] : [])]);
  if (question !== null && confirmed !== question) return { ok: false, needsConfirmation: true, error: question };

  const result = await insert(buildInsertRequest(build.request, prepared.stored, tripId, [vehicleId]));
  if (!result.ok) return { ok: false, error: result.error };
  // The optimizer must have taken the trip out of the route it is on here: otherwise the option would leave that
  // route as it is (or, read as empty, delete it with the other trips on it).
  if (result.data.fromVehicleId !== fromVehicleId) return { ok: false, error: PLACES_STALE_ERROR, stale: true };
  const option = result.data.options.find((o) => o.vehicleId === vehicleId);
  if (!option) {
    const why = result.data.rejected.find((r) => r.vehicleId === vehicleId)?.reason ?? "n'a plus de place pour elle";
    return { ok: false, error: `Place refusée\u00a0: ${targetLabel} ${why}. Le planning n'a pas changé.` };
  }
  const nowMinute = nowMinuteOn(isoDate);
  const late = nowMinute === null ? null : pastPlaceReason(option, nowMinute);
  if (late) return { ok: false, error: `Place refusée\u00a0: ${targetLabel} ${late}. Le planning n'a pas changé.` };

  const serviceDate = fromIsoDate(isoDate);
  const changed = [vehicleId, ...(fromVehicleId ? [fromVehicleId] : [])];
  const storedByVehicle = new Map(prepared.stored.map((route) => [route.vehicleId, route]));
  const outcome = await db.$transaction(async (tx) => {
    // Serialized with the computations, validations and other plan writes of the date (day-lock.ts).
    await lockPlanningDay(tx, isoDate);
    if (await optimizationInProgress(isoDate, tx)) return "running" as const;
    if ((await loadPlanVersion(tx, isoDate)) !== prepared.version) return "stale" as const;
    const routeIds = changed.flatMap((id) => storedByVehicle.get(id)?.id ?? []);
    if (routeIds.length > 0) {
      // Same row locks as savePlan and refresh-routes.ts: a crew's pick-up in flight waits, or is seen below.
      await tx.$queryRaw`SELECT "id" FROM "Route" WHERE "id" = ANY(${routeIds}) ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "RouteStop" WHERE "routeId" = ANY(${routeIds}) ORDER BY "id" FOR UPDATE`;
      const now = await tx.route.findMany({ where: { id: { in: routeIds } }, select: storedRouteSelect });
      const same = now.length === routeIds.length && now.every((route) => {
        const read = storedByVehicle.get(route.vehicleId);
        const ids = (stops: { id: string; sequence: number }[]) => [...stops].sort((a, b) => a.sequence - b.sequence).map((s) => s.id).join(" ");
        return read !== undefined && ids(read.stops) === ids(route.stops) && route.stops.every((stop) => stop.completedAt === null);
      });
      if (!same) return "stale" as const;
    }
    if (!storedByVehicle.has(vehicleId)) {
      // The route created takes the crew of the day: never someone still on another route of the date.
      const people = crewOf(build, vehicleId);
      const elsewhere =
        people.length === 0
          ? null
          : await tx.route.findFirst({
              where: { serviceDate, vehicleId: { not: vehicleId }, OR: [{ driverId: { in: people } }, { crewMateId: { in: people } }] },
              select: { vehicleId: true },
            });
      if (elsewhere) return { crewOn: labelOf(elsewhere.vehicleId) ?? "un autre véhicule" };
    }
    const tripIds = option.trips.map((t) => t.tripId);
    const [currentTrips, vehicles, dayRoutes] = await Promise.all([
      tx.trip.findMany({
        where: { id: { in: tripIds } },
        select: { id: true, status: true, sharingStatus: true, pickupAddress: true, dropoffAddress: true },
      }),
      tx.vehicle.findMany({ where: { id: { in: changed } }, select: { id: true, type: true } }),
      tx.route.findMany({ where: { serviceDate }, select: { status: true, validatedAt: true } }),
    ]);
    // A new route gets the crew the optimizer planned with: the crew of the day (as savePlan).
    const crewed = new Map<string, VehicleCrew>(
      vehicles.map((v) => {
        const crew = build.crews.get(v.id);
        return [v.id, { id: v.id, type: v.type, defaultDriverId: crew?.driverId ?? null, defaultCrewMateId: crew?.crewMateId ?? null }];
      }),
    );
    const write = planPlaceWrite({
      option,
      fromVehicleId,
      stored: storedByVehicle,
      vehicles: crewed,
      current: new Map<string, CurrentTrip>(currentTrips.map((t) => [t.id, t])),
      now: new Date(),
    });
    if (!write.routes.some((r) => r.row.vehicleId === vehicleId && r.row.stops.some((s) => s.tripId === tripId))) return "stale" as const;

    const planRunId = await updatePlanRun(tx, isoDate, option, fromVehicleId, prepared);
    const status = newRouteStatus(dayRoutes);
    // A route created on a validated day takes the day's validation time: the dashboard reads it as the end of planning.
    const validatedAt =
      dayRoutes
        .filter((route) => route.status === "VALIDATED")
        .map((route) => route.validatedAt)
        .reduce<Date | null>((latest, at) => (at && (!latest || at > latest) ? at : latest), null) ?? new Date();
    await writePlacedRoutes(tx, {
      serviceDate,
      write,
      storedByVehicle,
      matrixSource: result.data.meta.matrixSource,
      status,
      validatedAt,
      planRunId,
      // Placed by the regulator: a later optimization keeps it there (as « Déplacer vers… »).
      locks: new Map([[tripId, vehicleId]]),
    });
    await audit(tx, user, {
      action: "trip.move",
      entity: "Trip",
      entityId: tripId,
      serviceDate: isoDate,
      details: {
        mode: "insert",
        vehicleId: { from: fromVehicleId, to: vehicleId },
        lockedVehicleId: { from: prepared.trip.lockedVehicleId, to: vehicleId },
        // Drivers' roadmaps rewritten on a validated or started day, after the question was answered.
        ...(question !== null ? { confirmed: true, validated: prepared.validated, started: prepared.started } : {}),
      },
    });
    // An exceptional ambulance holds while the trip is locked on it: moved off it, the measure lapses.
    await withdrawLapsedProposals(tx, user, isoDate);
    return "saved" as const;
  }, PLANNING_TX_OPTIONS);

  if (outcome === "running") return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  if (outcome === "stale") return { ok: false, error: PLACES_STALE_ERROR, stale: true };
  if (typeof outcome === "object") return { ok: false, error: `Place refusée\u00a0: ${targetLabel} ${crewTakenReason(outcome.crewOn)}.`, stale: true };
  const message = placedMessage({ patient: prepared.trip.patientName, vehicleLabel: targetLabel, fromLabel, option });
  const kept = option.violations.length;
  if (kept === 0) return { ok: true, message };
  const rules = kept > 1 ? `${kept} contraintes déjà enfreintes par ces tournées le restent` : "1 contrainte déjà enfreinte par ces tournées le reste";
  return { ok: true, message: `${message} ${rules}\u00a0: voir «\u202fÀ traiter\u202f».`, warning: true };
}

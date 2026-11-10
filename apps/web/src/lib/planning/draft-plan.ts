/**
 * The drag-and-drop draft of the timeline, server side (INS-03). Shared by the planning server
 * actions (callers check auth).
 *
 * « Vérifier » replays the draft's moves, in order, on the plan of the moment: a trip dropped on a
 * vehicle goes to its best place in that vehicle's route as the optimizer's POST /insert finds it
 * for that vehicle alone (`vehicleIds`, the check « Appliquer » of « Où placer » makes: never a new
 * violation, nothing else of the day moved), a trip dropped on « À placer » leaves its route (the
 * other stops keep their order). A move the optimizer refuses is said, with why, and left out. The
 * plan in place and the draft are then both timed and checked by /evaluate: the figures, the
 * violations the draft adds, the other patients whose pickup moves by 10 min or more.
 *
 * « Enregistrer » checks the draft again on the data of the moment and writes it only if every move
 * still holds, on the version of the plan the regulator saw, under the planning lock of the date,
 * no computation of the date running and the routes changed as read (row locks, as « Appliquer »):
 * only the routes the draft changes are written, the stops that stay keeping their ids; each moved
 * trip is locked on its new vehicle (a trip put in « À placer » is unlocked: the next optimization
 * may place it again); one trip.move event per trip (details.mode « draft »). On a validated or
 * started day it asks first, as « Appliquer » does; a route under way is never changed.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { audit, type AuditActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { evaluate, insert } from "@/lib/optimizer/client";
import { violationSchema, type PlanResponse, type Violation } from "@/lib/optimizer/contract";
import { planRoutes, planTripUpdates, type CurrentTrip, type VehicleCrew } from "@/lib/optimizer/persist";
import { formatLongDate, fromIsoDate, todayIso } from "@/lib/time";
import { lockPlanningDay } from "./day-lock";
import {
  changedVehicles,
  DRAFT_MAX_MOVES,
  vehicleOfTrip,
  withOptionRoutes,
  withoutTrip,
  type DraftMove,
  type DraftMoveResult,
  type DraftRoute,
  type DraftSequence,
  type DraftTrip,
  type DraftView,
} from "./draft";
import { newRouteStatus, pastPlaceReason, placeQuestion, ROUTE_HOLD_REASONS } from "./insertion";
import { crewOf, crewTakenReason, loadPlaceDay, nowMinuteOn, tripPlaceIssue, writePlacedRoutes, type PlaceDay } from "./place-trip";
import { placementsOf, planChanges } from "./plan-changes";
import { figuresOfPlan, routesInPlace } from "./plan-compare";
import { relevantViolations } from "./refresh-routes";
import { optimizationInProgress, OPTIMIZATION_IN_PROGRESS_ERROR, PLANNING_TX_OPTIONS, withdrawLapsedProposals } from "./run-optimization";
import { loadPlanVersion } from "./version";

export const DRAFT_STALE_ERROR =
  "Le planning a changé depuis la vérification du brouillon\u00a0: il est vérifié de nouveau sur le planning du moment, enregistrez ensuite.";
export const DRAFT_EMPTY_ERROR = "Rien à enregistrer\u00a0: le brouillon ne change aucune tournée.";
/** Reason of a trip put in « À placer » by the draft, in the plan's list of trips without a vehicle. */
export const DRAFT_UNASSIGNED_REASON = "Retirée de sa tournée par le régulateur";

export type CheckDraftOutcome = { ok: true; view: DraftView } | { ok: false; error: string; stale?: boolean };

export type SaveDraftOutcome =
  | { ok: true; message: string; warning?: boolean }
  | { ok: false; error: string; needsConfirmation?: boolean; stale?: boolean; recheck?: boolean };

type Computed = {
  results: DraftMoveResult[];
  /** The stop sequences in place, and with the draft. */
  original: DraftSequence[];
  routes: DraftSequence[];
  before: PlanResponse;
  after: PlanResponse;
  changed: Set<string>;
};

const IN_FIELD = new Set(["PICKED_UP", "DROPPED_OFF"]);
const OFF = new Set(["CANCELLED", "NO_SHOW"]);

/** The day's request without a field the optimizer refuses with `routes` (the routes in place are given as `routes`). */
function dayFields(day: PlaceDay) {
  const { date, settings, vehicles, trips, tariffs } = day.build.request;
  return { date, settings, vehicles, trips, tariffs };
}

/**
 * Replays `moves` on the plan of `day`: each one placed (by /insert) or refused, then both plans
 * evaluated. A move that holds takes the trip's lock to where the save writes it (its new vehicle,
 * none for « À placer »): the later /insert calls and the draft's /evaluate see that lock, never the
 * old one (a trip figée on A then dragged onto B is no « LOCK » violation of the draft).
 */
async function computeDraft(day: PlaceDay, moves: readonly DraftMove[]): Promise<{ ok: true; computed: Computed } | { ok: false; error: string }> {
  const fields = dayFields(day);
  const original: DraftSequence[] = routesInPlace(day.stored, day.build.request) ?? [];
  // The plan in place is evaluated meanwhile: the same timing as the draft's, for the figures side by side.
  const beforeCall = evaluate({ ...fields, routes: original });
  const labels = new Map(day.build.request.vehicles.map((v) => [v.id, v.label]));
  const nowMinute = nowMinuteOn(day.isoDate);
  let routes = original;
  let trips = fields.trips;
  const relock = (tripId: string, vehicleId: string | null) => {
    trips = trips.map((t) => (t.id === tripId ? { ...t, lockedVehicleId: vehicleId } : t));
  };
  const results: DraftMoveResult[] = [];
  for (const move of moves.slice(0, DRAFT_MAX_MOVES)) {
    const from = vehicleOfTrip(routes, move.tripId);
    const refuse = (reason: string) => results.push({ ...move, fromVehicleId: from, ok: false, reason });
    const trip = day.input.trips.find((t) => t.id === move.tripId);
    if (!trip) {
      refuse("Course introuvable (supprimée entre-temps\u202f?).");
      continue;
    }
    if (OFF.has(trip.status)) {
      refuse("Cette course est annulée.");
      continue;
    }
    if (IN_FIELD.has(trip.status)) {
      refuse("Cette course est déjà commencée ou terminée.");
      continue;
    }
    const issue = tripPlaceIssue(day, move.tripId);
    if (issue) {
      refuse(issue.error);
      continue;
    }
    // Already where the move puts it (the plan changed meanwhile): nothing to do, no result, the browser drops the move.
    if (move.toVehicleId === from) continue;
    if (move.toVehicleId === null) {
      routes = withoutTrip(routes, move.tripId);
      relock(move.tripId, null);
      results.push({ ...move, fromVehicleId: from, ok: true, pickupMinute: null, dropoffMinute: null, deltaKm: null, deltaMargin: null });
      continue;
    }
    const label = labels.get(move.toVehicleId);
    if (!label) {
      refuse("Ce véhicule n'est pas disponible ce jour.");
      continue;
    }
    const hold = day.held.get(move.toVehicleId);
    if (hold) {
      refuse(`${label} ${ROUTE_HOLD_REASONS[hold]}.`);
      continue;
    }
    const taken = day.crewTaken.get(move.toVehicleId);
    if (taken !== undefined) {
      refuse(`${label} ${crewTakenReason(taken)}.`);
      continue;
    }
    const answer = await insert({ ...fields, trips, routes, tripId: move.tripId, vehicleIds: [move.toVehicleId] });
    if (!answer.ok) return { ok: false, error: answer.error };
    const option = answer.data.options.find((o) => o.vehicleId === move.toVehicleId);
    if (!option) {
      const why = answer.data.rejected.find((r) => r.vehicleId === move.toVehicleId)?.reason ?? "n'a pas de place pour elle";
      refuse(`${label} ${why}.`);
      continue;
    }
    const late = nowMinute === null ? null : pastPlaceReason(option, nowMinute);
    if (late) {
      refuse(`${label} ${late}.`);
      continue;
    }
    routes = withOptionRoutes(routes, option, answer.data.fromVehicleId);
    relock(move.tripId, move.toVehicleId);
    results.push({
      ...move,
      fromVehicleId: from,
      ok: true,
      pickupMinute: option.pickupMin,
      dropoffMinute: option.dropoffMin,
      deltaKm: option.deltaKm,
      deltaMargin: option.deltaMargin,
    });
  }
  const [before, after] = await Promise.all([beforeCall, evaluate({ ...fields, trips, routes })]);
  if (!before.ok) return { ok: false, error: before.error };
  if (!after.ok) return { ok: false, error: after.error };
  return { ok: true, computed: { results, original, routes, before: before.data, after: after.data, changed: changedVehicles(original, routes) } };
}

function draftRouteOf(route: PlanResponse["routes"][number]): DraftRoute {
  return {
    startMinute: route.startMin,
    endMinute: route.endMin,
    distanceKm: route.distanceKm,
    emptyKm: route.emptyKm,
    revenue: route.revenue,
    cost: route.cost,
    margin: route.margin,
    breakStartMinute: route.break?.startMin ?? null,
    breakEndMinute: route.break?.endMin ?? null,
    stops: route.stops.map((stop) => ({
      tripId: stop.tripId,
      kind: stop.kind,
      lat: stop.location.lat,
      lng: stop.location.lng,
      arrivalMinute: stop.arrivalMin,
      startMinute: stop.startMin,
      departureMinute: stop.departureMin,
      loadAfter: stop.loadAfter,
    })),
  };
}

/** The trips whose results the draft changes: those of the routes it changes (before and after), and those it moves. */
function touchedTrips(computed: Computed): Set<string> {
  const ids = new Set(computed.results.filter((r) => r.ok).map((r) => r.tripId));
  for (const routes of [computed.original, computed.routes]) {
    for (const route of routes) {
      if (computed.changed.has(route.vehicleId)) for (const stop of route.stops) ids.add(stop.tripId);
    }
  }
  return ids;
}

const violationKey = (v: Pick<Violation, "code" | "tripId" | "vehicleId">) => `${v.code}|${v.tripId ?? ""}|${v.vehicleId ?? ""}`;

function viewOf(day: PlaceDay, computed: Computed): DraftView {
  const { before, after, changed } = computed;
  const touched = touchedTrips(computed);
  const routes = [...changed].map((vehicleId) => {
    const route = after.routes.find((r) => r.vehicleId === vehicleId && r.stops.length > 0);
    return { vehicleId, route: route ? draftRouteOf(route) : null };
  });
  const trips: DraftTrip[] = after.trips
    .filter((t) => touched.has(t.tripId))
    .map((t) => ({
      tripId: t.tripId,
      vehicleId: t.vehicleId,
      pickupMinute: t.pickupMin,
      dropoffMinute: t.dropoffMin,
      shared: t.vehicleId !== null && t.shared,
      coPassengerTripIds: t.coPassengerTripIds,
      estimatedRevenue: t.vehicleId ? t.revenue : null,
      detourKm: t.vehicleId ? t.detourKm : null,
    }));
  const known = new Set(before.validation.violations.map(violationKey));
  const pickups = (plan: PlanResponse) => new Map(plan.trips.map((t) => [t.tripId, t.pickupMin]));
  const pickupBefore = pickups(before);
  const pickupAfter = pickups(after);
  const moved = new Set(computed.results.filter((r) => r.ok).map((r) => r.tripId));
  const shifted = planChanges(
    { routes: before.routes, placements: placementsOf(before.routes, (id) => pickupBefore.get(id) ?? null) },
    { routes: after.routes, placements: placementsOf(after.routes, (id) => pickupAfter.get(id) ?? null) },
  ).trips.flatMap((change) =>
    change.kind === "time" && !moved.has(change.tripId) && change.to && change.fromPickupMinute !== null && change.toPickupMinute !== null
      ? [{ tripId: change.tripId, vehicleId: change.to, fromPickupMinute: change.fromPickupMinute, toPickupMinute: change.toPickupMinute }]
      : [],
  );
  const labels = new Map(day.build.request.vehicles.map((v) => [v.id, v.label]));
  return {
    version: day.version,
    moves: computed.results,
    routes,
    trips,
    before: figuresOfPlan(before),
    after: figuresOfPlan(after),
    newViolations: after.validation.violations
      .filter((v) => !known.has(violationKey(v)))
      .map(({ code, message, tripId, vehicleId }) => ({ code, message, tripId, vehicleId })),
    shifted,
    question:
      changed.size > 0
        ? placeQuestion({ validated: day.validated, started: day.started }, [...changed].map((id) => labels.get(id) ?? "un véhicule"))
        : null,
  };
}

/** Why the draft of `isoDate` cannot be checked or saved at all (past date, no routes), or null. */
function dateIssue(isoDate: string): string | null {
  return isoDate < todayIso() ? `Le ${formatLongDate(isoDate)} est passé\u00a0: son planning n'est plus modifiable.` : null;
}

/** « Vérifier » : the draft's moves replayed on the plan of the moment, nothing written. */
export async function checkDraftPlan(isoDate: string, moves: readonly DraftMove[]): Promise<CheckDraftOutcome> {
  const past = dateIssue(isoDate);
  if (past) return { ok: false, error: past };
  const loaded = await loadPlaceDay(isoDate);
  if (!loaded.ok) return loaded;
  const began = Date.now();
  const computed = await computeDraft(loaded.day, moves);
  if (!computed.ok) return computed;
  console.info(
    `[planning] draft of ${isoDate}: ${moves.length} move(s), ${computed.computed.changed.size} route(s) changed, ${Date.now() - began} ms`,
  );
  return { ok: true, view: viewOf(loaded.day, computed.computed) };
}

/** The plan run's stored violations and trips without a vehicle once the draft is saved (its routes re-checked). */
async function updatePlanRun(
  tx: Prisma.TransactionClient,
  isoDate: string,
  day: PlaceDay,
  computed: Computed,
  touched: ReadonlySet<string>,
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
  const { request } = day.build;
  const replaced = new Set(relevantViolations({ validation: { valid: false, violations: stored } }, request, computed.changed, touched));
  const violations = [...stored.filter((v) => !replaced.has(v)), ...relevantViolations(computed.after, request, computed.changed, touched)];
  const served = new Set(computed.after.trips.filter((t) => t.vehicleId !== null).map((t) => t.tripId));
  const takenOut = computed.results.filter((r) => r.ok && r.toVehicleId === null).map((r) => r.tripId);
  const previous = Array.isArray(details.unassigned) ? details.unassigned : [];
  const unassigned = [
    ...previous.filter((u) => {
      const tripId = u && typeof u === "object" && !Array.isArray(u) ? u.tripId : null;
      return typeof tripId !== "string" || (!served.has(tripId) && !takenOut.includes(tripId));
    }),
    ...takenOut.map((tripId) => ({ tripId, reason: DRAFT_UNASSIGNED_REASON })),
  ];
  await tx.optimizationRun.update({
    where: { id: run.id },
    data: {
      valid: violations.length === 0,
      details: { ...details, violations, unassigned } as Prisma.InputJsonObject,
    },
  });
  return run.id;
}

/**
 * « Enregistrer » : the draft's moves, checked again on the data of the moment, written if each one
 * still holds and the plan is still the version the regulator saw (`shownVersion`). `confirmed`:
 * the question answered on a validated or started day (asked again when it changed).
 */
export async function saveDraftPlan(
  isoDate: string,
  shownVersion: string,
  moves: readonly DraftMove[],
  confirmed: string | null,
  user: AuditActor,
): Promise<SaveDraftOutcome> {
  const past = dateIssue(isoDate);
  if (past) return { ok: false, error: past };
  const loaded = await loadPlaceDay(isoDate);
  if (!loaded.ok) return loaded;
  const { day } = loaded;
  if (day.version !== shownVersion) return { ok: false, error: DRAFT_STALE_ERROR, stale: true };
  if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  const result = await computeDraft(day, moves);
  if (!result.ok) return result;
  const { computed } = result;
  const refused = computed.results.filter((r) => !r.ok);
  if (refused.length > 0) {
    const first = refused[0];
    const why = first && !first.ok ? first.reason : "";
    return {
      ok: false,
      error: `${refused.length > 1 ? `${refused.length} modifications ne tiennent plus` : "Une modification ne tient plus"}\u00a0: ${why} Rien n'a été enregistré.`,
      recheck: true,
    };
  }
  // Every move does nothing now (the trips are already where the draft puts them): checked again, the browser drops them.
  if (computed.changed.size === 0) return { ok: false, error: DRAFT_EMPTY_ERROR, recheck: true };
  const view = viewOf(day, computed);
  if (view.question !== null && confirmed !== view.question) return { ok: false, needsConfirmation: true, error: view.question };

  const serviceDate = fromIsoDate(isoDate);
  const { build } = day;
  const storedByVehicle = new Map(day.stored.map((route) => [route.vehicleId, route]));
  const touched = touchedTrips(computed);
  const moved = computed.results.filter((r): r is Extract<DraftMoveResult, { ok: true }> => r.ok);
  const labelOf = (id: string) => build.request.vehicles.find((v) => v.id === id)?.label ?? null;
  const outcome = await db.$transaction(async (tx) => {
    // Serialized with the computations, validations and other plan writes of the date (day-lock.ts).
    await lockPlanningDay(tx, isoDate);
    if (await optimizationInProgress(isoDate, tx)) return "running" as const;
    if ((await loadPlanVersion(tx, isoDate)) !== day.version) return "stale" as const;
    const routeIds = [...computed.changed].flatMap((id) => storedByVehicle.get(id)?.id ?? []);
    if (routeIds.length > 0) {
      // Same row locks as savePlan and « Appliquer »: a crew's pick-up in flight waits, or is seen below.
      await tx.$queryRaw`SELECT "id" FROM "Route" WHERE "id" = ANY(${routeIds}) ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "RouteStop" WHERE "routeId" = ANY(${routeIds}) ORDER BY "id" FOR UPDATE`;
      const now = await tx.route.findMany({
        where: { id: { in: routeIds } },
        select: { id: true, vehicleId: true, stops: { select: { id: true, sequence: true, completedAt: true } } },
      });
      const ids = (stops: { id: string; sequence: number }[]) => [...stops].sort((a, b) => a.sequence - b.sequence).map((s) => s.id).join(" ");
      const same =
        now.length === routeIds.length &&
        now.every((route) => {
          const read = storedByVehicle.get(route.vehicleId);
          return read !== undefined && ids(read.stops) === ids(route.stops) && route.stops.every((stop) => stop.completedAt === null);
        });
      if (!same) return "stale" as const;
    }
    // A route created takes the crew of the day: never someone still on another route of the date.
    const created = [...computed.changed].filter((id) => !storedByVehicle.has(id) && computed.routes.some((r) => r.vehicleId === id));
    for (const vehicleId of created) {
      const people = crewOf(build, vehicleId);
      if (people.length === 0) continue;
      const elsewhere = await tx.route.findFirst({
        where: { serviceDate, vehicleId: { not: vehicleId }, OR: [{ driverId: { in: people } }, { crewMateId: { in: people } }] },
        select: { vehicleId: true },
      });
      if (elsewhere) return { crewOn: labelOf(elsewhere.vehicleId) ?? "un autre véhicule", vehicle: labelOf(vehicleId) ?? "Ce véhicule" };
    }
    const [currentTrips, vehicles, dayRoutes] = await Promise.all([
      tx.trip.findMany({
        where: { id: { in: [...touched] } },
        select: { id: true, status: true, sharingStatus: true, pickupAddress: true, dropoffAddress: true },
      }),
      tx.vehicle.findMany({ where: { id: { in: [...computed.changed] } }, select: { id: true, type: true } }),
      tx.route.findMany({ where: { serviceDate }, select: { status: true, validatedAt: true } }),
    ]);
    const current = new Map<string, CurrentTrip>(currentTrips.map((t) => [t.id, t]));
    // A new route gets the crew the optimizer planned with: the crew of the day (as savePlan).
    const crewed = new Map<string, VehicleCrew>(
      vehicles.map((v) => {
        const crew = build.crews.get(v.id);
        return [v.id, { id: v.id, type: v.type, defaultDriverId: crew?.driverId ?? null, defaultCrewMateId: crew?.crewMateId ?? null }];
      }),
    );
    const rows = planRoutes({ routes: computed.after.routes.filter((r) => computed.changed.has(r.vehicleId)) }, crewed, current);
    const kept = new Set(rows.map((row) => row.vehicleId));
    const write = {
      routes: rows.map((row) => ({ routeId: storedByVehicle.get(row.vehicleId)?.id ?? null, row })),
      deletedRouteIds: [...computed.changed].filter((id) => !kept.has(id)).flatMap((id) => storedByVehicle.get(id)?.id ?? []),
      trips: planTripUpdates([...touched], computed.after, rows, current, new Date()),
    };
    // Every moved trip must end where the draft put it: otherwise the plan changed under the draft.
    const servedBy = new Map(write.trips.map((t) => [t.tripId, t.vehicleId]));
    if (moved.some((m) => (servedBy.get(m.tripId) ?? null) !== m.toVehicleId)) return "stale" as const;

    const planRunId = await updatePlanRun(tx, isoDate, day, computed, touched);
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
      matrixSource: computed.after.meta.matrixSource,
      status,
      validatedAt,
      planRunId,
      // Placed by the regulator: a later optimization keeps the trip there; one put in « À placer » is unlocked.
      locks: new Map(moved.map((m) => [m.tripId, m.toVehicleId])),
    });
    const lockBefore = new Map(day.input.trips.map((t) => [t.id, t.lockedVehicleId]));
    await audit(
      tx,
      user,
      moved.map((m) => ({
        action: "trip.move" as const,
        entity: "Trip" as const,
        entityId: m.tripId,
        serviceDate: isoDate,
        details: {
          mode: "draft",
          vehicleId: { from: vehicleOfTrip(computed.original, m.tripId), to: m.toVehicleId },
          lockedVehicleId: { from: lockBefore.get(m.tripId) ?? null, to: m.toVehicleId },
          // Drivers' roadmaps rewritten on a validated or started day, after the question was answered.
          ...(view.question !== null ? { confirmed: true, validated: day.validated, started: day.started } : {}),
        },
      })),
    );
    // An exceptional ambulance holds while the trip is locked on it: moved off it, the measure lapses.
    await withdrawLapsedProposals(tx, user, isoDate);
    return "saved" as const;
  }, PLANNING_TX_OPTIONS);

  if (outcome === "running") return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  if (outcome === "stale") return { ok: false, error: DRAFT_STALE_ERROR, stale: true, recheck: true };
  if (typeof outcome === "object") {
    return { ok: false, error: `Modification refusée\u00a0: ${outcome.vehicle} ${crewTakenReason(outcome.crewOn)}.`, stale: true };
  }
  return { ok: true, ...savedMessage(view, moved.length, moved.filter((m) => m.toVehicleId !== null).length) };
}

/** « 3 modifications enregistrées, courses figées sur leur nouveau véhicule : 4 tournées réécrites, les autres inchangées · marge +45 € · −12 km. » */
function savedMessage(view: DraftView, moves: number, locked: number): { message: string; warning?: boolean } {
  const routes = view.routes.length;
  const margin = Math.round(view.after.margin - view.before.margin);
  const km = Math.round(view.after.km - view.before.km);
  const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `\u2212${-value}` : "0");
  const what = moves > 1 ? `${moves} modifications enregistrées` : "Modification enregistrée";
  const parts = [
    `${routes} ${routes > 1 ? "tournées réécrites" : "tournée réécrite"}, les autres inchangées`,
    `marge ${signed(margin)}\u00a0€`,
    `${signed(km)}\u00a0km`,
  ];
  if (view.newViolations.length > 0) parts.push(`${view.newViolations.length} violation${view.newViolations.length > 1 ? "s" : ""} à vérifier`);
  const lockNote = locked === 0 ? "" : locked > 1 ? ", courses figées sur leur nouveau véhicule" : ", course figée sur son nouveau véhicule";
  const message = `${what}${lockNote}\u00a0: ${parts.join(" · ")}.`;
  return view.newViolations.length > 0 ? { message, warning: true } : { message };
}

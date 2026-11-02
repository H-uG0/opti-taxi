/** Database queries of the planning page. */
import "server-only";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { VEHICLE_TYPE_HEX } from "@/components/ui/badge";
import { tripInputSelect, vehicleInputSelect } from "@/lib/optimizer/build-request";
import { readRunDetails, type RunDetails } from "@/lib/optimizer/run-details";
import { fromIsoDate } from "@/lib/time";
import type { PlanningDayView } from "./types";
import { buildPlanningView } from "./view";

const runSelect = {
  id: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  wallTimeMs: true,
  matrixSource: true,
  valid: true,
  error: true,
  tripsCount: true,
  lockedCount: true,
  unassignedCount: true,
  /** Optimizer KPIs and run details (violations, warnings, unassigned reasons). */
  kpis: true,
  requestedBy: { select: { name: true } },
} as const;

const personSelect = { select: { firstName: true, lastName: true } } as const;

export async function loadPlanningDay(isoDate: string): Promise<PlanningDayView & { timeLimitSec: number }> {
  const serviceDate = fromIsoDate(isoDate);
  const [settings, vehicles, trips, routes, lastRun, planRun] = await Promise.all([
    getSettings(db),
    db.vehicle.findMany({
      select: { ...vehicleInputSelect, registration: true, depotLabel: true },
      orderBy: { label: "asc" },
    }),
    db.trip.findMany({
      where: { serviceDate },
      select: {
        ...tripInputSelect,
        payer: true,
        pickupAddress: true,
        dropoffAddress: true,
        routeId: true,
        plannedPickupMinute: true,
        plannedDropoffMinute: true,
        shared: true,
        directKm: true,
        detourKm: true,
        estimatedRevenue: true,
        createdAt: true,
        patient: personSelect,
        facility: { select: { name: true } },
      },
    }),
    db.route.findMany({
      where: { serviceDate },
      select: {
        id: true,
        vehicleId: true,
        status: true,
        startMinute: true,
        endMinute: true,
        distanceKm: true,
        emptyKm: true,
        revenue: true,
        cost: true,
        margin: true,
        breakStartMinute: true,
        breakEndMinute: true,
        validatedAt: true,
        driver: personSelect,
        crewMate: personSelect,
        stops: {
          orderBy: { sequence: "asc" },
          select: {
            id: true,
            sequence: true,
            tripId: true,
            kind: true,
            lat: true,
            lng: true,
            address: true,
            arrivalMinute: true,
            startMinute: true,
            departureMinute: true,
            loadAfter: true,
            completedAt: true,
          },
        },
      },
    }),
    db.optimizationRun.findFirst({ where: { serviceDate }, orderBy: { startedAt: "desc" }, select: runSelect }),
    db.optimizationRun.findFirst({
      where: { serviceDate, status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      select: runSelect,
    }),
  ]);

  const details = new Map<string, RunDetails>();
  for (const run of [lastRun, planRun]) {
    const found = run ? readRunDetails(run.id, run.kpis) : null;
    if (found) details.set(found.runId, found);
  }

  const view = buildPlanningView({
    date: isoDate,
    settings,
    vehicles,
    trips,
    routes,
    lastRun,
    planRun,
    details,
    baseColors: VEHICLE_TYPE_HEX,
  });
  return { ...view, timeLimitSec: settings.solverTimeLimitSec };
}

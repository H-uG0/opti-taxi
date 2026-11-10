/** Database queries of the planning page. */
import "server-only";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { VEHICLE_TYPE_HEX } from "@/components/ui/badge";
import {
  applyDayCrewPlan,
  loadDayCrewContext,
  loadBillingInput,
  loadTariffInputs,
  tripInputSelect,
  vehicleInputSelect,
} from "@/lib/optimizer/build-request";
import { readRunDetails, type RunDetails } from "@/lib/optimizer/run-details";
import { DEFAULT_CREW_RULES, type CrewRules } from "@/lib/staff/day-crews";
import { crewChoices, type CrewChoice } from "@/lib/staff/route-crew";
import { fromIsoDate } from "@/lib/time";
import { vehicleIssues } from "./route-issues";
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
  /** Run details (violations, warnings, unassigned reasons); kpis for runs saved before the details column. */
  details: true,
  kpis: true,
  requestedBy: { select: { name: true } },
} as const;

const personSelect = { select: { firstName: true, lastName: true } } as const;

/** Account that recorded a sharing answer or a stop status: its name only. */
const recorderSelect = { select: { name: true } } as const;

export async function loadPlanningDay(
  isoDate: string,
): Promise<PlanningDayView & { timeLimitSec: number; crewChoices: CrewChoice[]; crewRules: CrewRules }> {
  const serviceDate = fromIsoDate(isoDate);
  const [settings, defaultVehicles, crewContext, trips, routes, lastRun, planRun, tariffs, billing] = await Promise.all([
    getSettings(db),
    db.vehicle.findMany({
      select: { ...vehicleInputSelect, registration: true, depot: { select: { id: true, lat: true, lng: true, name: true } } },
      orderBy: { label: "asc" },
    }),
    // Crews of the day (absences, replacements, crews fixed on the Équipages page).
    loadDayCrewContext(db, isoDate),
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
        sharingRespondedAt: true,
        sharingRespondedBy: recorderSelect,
        notes: true,
        // Shown in the trip panel to call the patient or brief the crew (the page traces plan.view).
        patient: { select: { firstName: true, lastName: true, phone: true, mobility: true, accessNotes: true } },
        facility: { select: { name: true, phone: true } },
      },
    }),
    db.route.findMany({
      where: { serviceDate },
      select: {
        id: true,
        vehicleId: true,
        driverId: true,
        crewMateId: true,
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
            completedBy: recorderSelect,
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
    loadTariffInputs(db, isoDate),
    loadBillingInput(db, isoDate),
  ]);

  const details = new Map<string, RunDetails>();
  for (const run of [lastRun, planRun]) {
    const found = run ? readRunDetails(run) : null;
    if (found) details.set(found.runId, found);
  }

  const vehicles = applyDayCrewPlan(defaultVehicles, crewContext.plan, crewContext.people);
  // Routes planned before a change of vehicle or crew, overdue inspection or insurance.
  const issues = vehicleIssues({
    date: isoDate,
    routes,
    vehicles: defaultVehicles,
    plan: crewContext.plan,
    absences: crewContext.input.absences,
    people: crewContext.people,
    fleetAlerts: crewContext.fleetAlerts,
  });
  const view = buildPlanningView({
    date: isoDate,
    settings,
    vehicles,
    trips,
    routes,
    lastRun,
    planRun,
    details,
    tariffs,
    billing,
    vehicleIssues: issues,
    baseColors: VEHICLE_TYPE_HEX,
  });
  // « Changer l'équipage » of a route: everyone active, with their absence and route of the day.
  const labelOf = new Map(defaultVehicles.map((v) => [v.id, v.label]));
  const choices = crewChoices(
    isoDate,
    [...crewContext.people.values()],
    crewContext.input.absences,
    routes.map((r) => ({ vehicleId: r.vehicleId, vehicleLabel: labelOf.get(r.vehicleId) ?? "Véhicule", driverId: r.driverId, crewMateId: r.crewMateId })),
    crewContext.input.depots ?? [],
  );
  // view.timeLimitSec: the solver budget scaled with the day's trips, not the bare setting.
  return { ...view, crewChoices: choices, crewRules: crewContext.input.rules ?? DEFAULT_CREW_RULES };
}

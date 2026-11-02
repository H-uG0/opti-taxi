import { describe, expect, it } from "vitest";
import type { DriverInput, SettingsInput } from "@/lib/optimizer/build-request";
import type { RunDetails } from "@/lib/optimizer/run-details";
import { buildPlanningView, computeDayKpis, dayStatusOf, waitAtFacility, type PlanningRawInput, type RawRoute, type RawRun, type RawTrip, type RawVehicle } from "./view";

const DATE = "2026-11-03"; // Tuesday

const settings: SettingsInput = {
  waitBeforeAppointmentMin: 30,
  waitAfterSessionMin: 15,
  maxTotalWaitMin: 45,
  maxDetourKmPerExtraPatient: 10,
  maxDetourKmTotal: 30,
  pickupServiceMin: 5,
  dropoffServiceMin: 5,
  unassignedPenalty: 10000,
  solverTimeLimitSec: 10,
};

const driver = (id: string, workDays = [1, 2, 3, 4, 5]): DriverInput => ({
  id,
  firstName: "Jean",
  lastName: id,
  active: true,
  workDays,
  shiftStartMinute: 360,
  shiftEndMinute: 1140,
  breakWindowStartMinute: null,
  breakWindowEndMinute: null,
  breakMinutes: 0,
  hourlyCost: 24,
});

const vehicle = (id: string, label: string, workDays?: number[]): RawVehicle => ({
  id,
  label,
  registration: `AA-${id}`,
  depotLabel: "Marseille",
  type: "TAXI",
  capacity: 2,
  depotLat: 43.3,
  depotLng: 5.37,
  department: "13",
  costPerKm: 0.3,
  active: true,
  defaultDriver: driver(`d_${id}`, workDays),
  defaultCrewMate: null,
});

const trip = (id: string, overrides: Partial<RawTrip> = {}): RawTrip => ({
  id,
  patientId: `p_${id}`,
  facilityId: "f1",
  direction: "OUTBOUND",
  status: "PLANNED",
  pickupLat: 43.31,
  pickupLng: 5.39,
  dropoffLat: 43.52,
  dropoffLng: 5.44,
  appointmentMinute: 480,
  readyMinute: null,
  allowedVehicleTypes: ["TAXI", "VSL"],
  sharingAllowed: true,
  sharingStatus: "NOT_PROPOSED",
  lockedVehicleId: null,
  payer: "CPAM",
  pickupAddress: `Domicile ${id}`,
  dropoffAddress: "Centre de dialyse",
  routeId: null,
  plannedPickupMinute: null,
  plannedDropoffMinute: null,
  shared: false,
  directKm: 20,
  detourKm: null,
  estimatedRevenue: null,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  patient: { firstName: "Patient", lastName: id.toUpperCase() },
  facility: { name: "Dialyse Aix" },
  ...overrides,
});

const stop = (id: string, sequence: number, tripId: string, kind: "PICKUP" | "DROPOFF", minute: number, loadAfter: number) => ({
  id,
  sequence,
  tripId,
  kind,
  lat: 43.4,
  lng: 5.4,
  address: "adresse",
  arrivalMinute: minute,
  startMinute: minute,
  departureMinute: minute + 5,
  loadAfter,
  completedAt: null,
});

const route = (overrides: Partial<RawRoute> = {}): RawRoute => ({
  id: "r1",
  vehicleId: "v1",
  status: "PROPOSED",
  startMinute: 400,
  endMinute: 560,
  distanceKm: 100,
  emptyKm: 25,
  revenue: 150,
  cost: 90,
  margin: 60,
  breakStartMinute: null,
  breakEndMinute: null,
  validatedAt: null,
  driver: { firstName: "Jean", lastName: "Route" },
  crewMate: null,
  stops: [
    stop("s1", 0, "a", "PICKUP", 420, 1),
    stop("s2", 1, "b", "PICKUP", 430, 2),
    stop("s3", 2, "a", "DROPOFF", 460, 1),
    stop("s4", 3, "b", "DROPOFF", 470, 0),
  ],
  ...overrides,
});

const run = (overrides: Partial<RawRun> = {}): RawRun => ({
  id: "run1",
  status: "SUCCESS",
  startedAt: new Date("2026-11-02T17:00:00Z"),
  finishedAt: new Date("2026-11-02T17:00:12Z"),
  wallTimeMs: 10_000,
  matrixSource: "haversine",
  valid: false,
  error: null,
  tripsCount: 4,
  lockedCount: 0,
  unassignedCount: 1,
  requestedBy: { name: "Régulateur" },
  ...overrides,
});

function input(overrides: Partial<PlanningRawInput> = {}): PlanningRawInput {
  return {
    date: DATE,
    settings,
    vehicles: [vehicle("v1", "Taxi 1"), vehicle("v2", "Taxi 2"), vehicle("v3", "Taxi 3", [6, 7])],
    trips: [
      trip("a", { routeId: "r1", status: "ASSIGNED", shared: true, plannedPickupMinute: 420, plannedDropoffMinute: 460 }),
      trip("b", { routeId: "r1", status: "ASSIGNED", shared: true, plannedPickupMinute: 430, plannedDropoffMinute: 470 }),
      trip("c"),
      trip("d", { createdAt: new Date("2026-11-02T18:00:00Z") }),
      trip("x", { status: "CANCELLED" }),
    ],
    routes: [route()],
    lastRun: run(),
    planRun: run(),
    details: new Map(),
    baseColors: { TAXI: "#c27c0e", VSL: "#2563eb", AMBULANCE: "#dc2626" },
    ...overrides,
  };
}

describe("buildPlanningView", () => {
  it("lists vehicles with a route first, then available ones; unavailable ones only as skipped", () => {
    const view = buildPlanningView(input());
    expect(view.vehicles.map((v) => [v.id, v.route?.id ?? null])).toEqual([
      ["v1", "r1"],
      ["v2", null],
    ]);
    expect(view.skippedVehicles.map((s) => s.vehicleId)).toEqual(["v3"]);
    expect(view.vehicles[0]).toMatchObject({ driverName: "Jean Route", shift: { start: 360, end: 1140 }, available: true });
    expect(view.vehicles[0]?.color).not.toBe(view.vehicles[1]?.color);
  });

  it("derives co-passengers and wait at the facility of served trips", () => {
    const view = buildPlanningView(input());
    const a = view.trips.find((t) => t.id === "a");
    expect(a).toMatchObject({ vehicleId: "v1", coPassengerTripIds: ["b"], waitAtFacilityMin: 20 });
    expect(view.trips.some((t) => t.id === "x")).toBe(false);
  });

  it("explains unassigned trips: optimizer reason, added later, or generic", () => {
    const details: RunDetails = {
      runId: "run1",
      solverStatus: "ROUTING_SUCCESS",
      violations: [{ code: "TIME_WINDOW", message: "Retard de 5 min", tripId: "a", vehicleId: "v1" }],
      warnings: ["Pas de grille"],
      unassigned: [{ tripId: "c", reason: "Aucun véhicule compatible disponible" }],
    };
    const view = buildPlanningView(input({ details: new Map([["run1", details]]) }));
    expect(view.unassigned).toEqual([
      { tripId: "c", reason: "Aucun véhicule compatible disponible" },
      { tripId: "d", reason: "Ajoutée après la dernière optimisation" },
    ]);
    expect(view.violations).toEqual([
      { code: "TIME_WINDOW", label: "Hors fenêtre horaire", message: "Retard de 5 min", tripId: "a", vehicleId: "v1" },
    ]);
    expect(view.violationsKnown).toBe(true);
    expect(view.kpis.violations).toBe(1);
    expect(view.planRun?.warnings).toEqual(["Pas de grille"]);

    const withoutDetails = buildPlanningView(input());
    expect(withoutDetails.unassigned[0]?.reason).toBe("Non affectée lors de la dernière optimisation");
    expect(withoutDetails.violationsKnown).toBe(false);
    expect(withoutDetails.kpis.violations).toBeNull();
  });

  it("flags cancelled trips still on a route and locks contradicted by the plan", () => {
    const view = buildPlanningView(
      input({
        trips: [
          trip("a", { routeId: "r1", status: "CANCELLED" }),
          trip("b", { routeId: "r1", status: "ASSIGNED", lockedVehicleId: "v2" }),
        ],
      }),
    );
    expect(view.staleTrips.map((s) => s.tripId)).toEqual(["a", "b"]);
    expect(view.trips.some((t) => t.id === "a")).toBe(true);
  });

  it("reports the day status, the start of the day and a fitted time range", () => {
    expect(buildPlanningView(input({ routes: [], trips: [] })).dayStatus).toBe("EMPTY");
    const view = buildPlanningView(input());
    expect(view.dayStatus).toBe("PROPOSED");
    expect(view.dayStarted).toBe(false);
    expect(view.timeRange).toEqual({ start: 360, end: 1140 });
    const started = buildPlanningView(input({ trips: [trip("a", { routeId: "r1", status: "PICKED_UP" })] }));
    expect(started.dayStarted).toBe(true);
  });
});

describe("helpers", () => {
  it("computes the KPIs from routes and trips", () => {
    const kpis = computeDayKpis(
      [
        { status: "ASSIGNED", vehicleId: "v1", shared: true },
        { status: "ASSIGNED", vehicleId: "v1", shared: false },
        { status: "PLANNED", vehicleId: null, shared: false },
        { status: "CANCELLED", vehicleId: null, shared: false },
      ],
      [{ distanceKm: 100, emptyKm: 25, revenue: 150, margin: 60, stops: [1, 2] }],
      0,
    );
    expect(kpis).toEqual({
      tripsTotal: 3,
      tripsServed: 2,
      vehiclesUsed: 1,
      tripsPerVehicle: 2,
      totalKm: 100,
      emptyKm: 25,
      emptyKmRatio: 0.25,
      sharedTrips: 1,
      sharedTripRatio: 0.5,
      revenue: 150,
      margin: 60,
      violations: 0,
    });
  });

  it("derives the day status", () => {
    expect(dayStatusOf(3, [])).toBe("UNPLANNED");
    expect(dayStatusOf(3, [{ status: "VALIDATED" }, { status: "VALIDATED" }])).toBe("VALIDATED");
    expect(dayStatusOf(3, [{ status: "VALIDATED" }, { status: "PROPOSED" }])).toBe("MIXED");
  });

  it("measures the wait at the facility in both directions", () => {
    const base = { appointmentMinute: 480, readyMinute: 690, plannedPickupMinute: 700, plannedDropoffMinute: 455 };
    expect(waitAtFacility({ ...base, direction: "OUTBOUND" })).toBe(25);
    expect(waitAtFacility({ ...base, direction: "RETURN" })).toBe(10);
    expect(waitAtFacility({ ...base, direction: "RETURN", plannedPickupMinute: null })).toBeNull();
  });
});

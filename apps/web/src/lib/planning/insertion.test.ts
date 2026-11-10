import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { insertResponseSchema, type DayRequest, type InsertResponse, type Violation } from "@/lib/optimizer/contract";
import type { CurrentTrip, VehicleCrew } from "@/lib/optimizer/persist";
import {
  buildInsertRequest,
  newRouteStatus,
  placedMessage,
  placeQuestion,
  placesView,
  planPlaceWrite,
  ROUTE_HOLD_REASONS,
  routeHold,
  violationsAfterPlace,
  type StoredPlaceRoute,
} from "./insertion";

const fixtures = path.resolve(__dirname, "../../../../../contract/fixtures");
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
/** trip_1 without a vehicle, placed beside trip_3 on the taxi (contract example). */
const placed = (): InsertResponse => insertResponseSchema.parse(load("insert-response.json"));

function stop(tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, completedAt: Date | null = null) {
  return { id: `${tripId}-${kind}`, tripId, kind, sequence, completedAt };
}

function storedRoute(overrides: Partial<StoredPlaceRoute> = {}): StoredPlaceRoute {
  return {
    id: "route-taxi",
    vehicleId: "veh_taxi_1",
    status: "PROPOSED",
    driverId: "drv-1",
    crewMateId: null,
    stops: [stop("trip_3", "PICKUP", 0), stop("trip_3", "DROPOFF", 1)],
    ...overrides,
  };
}

describe("routeHold", () => {
  const sent = new Set(["trip_3", "trip_9"]);
  const crews = new Map([["veh_taxi_1", { driverId: "drv-1" }]]);

  it("keeps a route under way, one holding a trip no longer sent, and one saved with another crew", () => {
    expect(routeHold(storedRoute(), sent, () => "ASSIGNED", crews)).toBeNull();
    expect(routeHold(storedRoute({ stops: [stop("trip_3", "PICKUP", 0, new Date()), stop("trip_3", "DROPOFF", 1)] }), sent, () => "ASSIGNED", crews)).toBe("STARTED");
    // Picked up on the phone before the stop was recorded: under way too.
    expect(routeHold(storedRoute(), sent, () => "PICKED_UP", crews)).toBe("STARTED");
    // Rewriting the route would drop the cancelled or incomplete trip from it.
    expect(routeHold(storedRoute({ stops: [stop("trip_x", "PICKUP", 0), stop("trip_x", "DROPOFF", 1)] }), sent, () => undefined, crews)).toBe(
      "OFF_REQUEST",
    );
    expect(routeHold(storedRoute({ driverId: "drv-2" }), sent, () => "ASSIGNED", crews)).toBe("CREW");
    expect(ROUTE_HOLD_REASONS.STARTED).toBe("a une tournée commencée, qui ne change plus en cours de journée");
  });
});

describe("buildInsertRequest", () => {
  it("sends the day, the stored routes as stop sequences of the trips and vehicles sent, the trip and the vehicles tried", () => {
    const { date, settings, vehicles, trips, tariffs } = load("evaluate-request.json") as DayRequest;
    const request: DayRequest = { date, settings, vehicles, trips, tariffs };
    const stored = [
      storedRoute({ stops: [stop("trip_3", "DROPOFF", 1), stop("trip_3", "PICKUP", 0), stop("trip_gone", "PICKUP", 2), stop("trip_gone", "DROPOFF", 3)] }),
      storedRoute({ id: "route-old", vehicleId: "veh_gone", stops: [stop("trip_5", "PICKUP", 0), stop("trip_5", "DROPOFF", 1)] }),
    ];
    const sent = buildInsertRequest(request, stored, "trip_1", ["veh_vsl_1"]);
    expect(sent.tripId).toBe("trip_1");
    expect(sent.vehicleIds).toEqual(["veh_vsl_1"]);
    expect(sent.routes).toEqual([
      {
        vehicleId: "veh_taxi_1",
        stops: [
          { tripId: "trip_3", kind: "PICKUP" },
          { tripId: "trip_3", kind: "DROPOFF" },
        ],
      },
    ]);
    expect(buildInsertRequest(request, [], "trip_1", null)).toMatchObject({ routes: [], vehicleIds: null });
  });
});

describe("placesView", () => {
  it("keeps what the panel shows of each place, its largest shift per trip, and adds the routes held", () => {
    const view = placesView(placed(), [{ vehicleId: "veh_amb_1", kind: "STARTED", reason: ROUTE_HOLD_REASONS.STARTED }], "v-7", 812);
    expect(view).toMatchObject({ tripId: "trip_1", fromVehicleId: null, version: "v-7", elapsedMs: 812, straightLine: true });
    expect(view.options).toEqual([
      {
        vehicleId: "veh_taxi_1",
        pickupMinute: 368,
        dropoffMinute: 420,
        shared: true,
        coPassengerTripIds: ["trip_3"],
        deltaKm: 0.03,
        deltaEmptyKm: -3.54,
        deltaDurationMin: 6,
        deltaRevenue: 36.34,
        deltaMargin: 33.93,
        shifts: [{ tripId: "trip_3", minutes: 5 }],
        remainingViolations: 0,
      },
    ]);
    expect(view.rejected.map((r) => [r.vehicleId, r.kind])).toEqual([
      ["veh_vsl_1", "SHIFT"],
      ["veh_amb_1", "STARTED"],
    ]);
  });

  it("never offers a vehicle whose route the web holds", () => {
    const view = placesView(placed(), [{ vehicleId: "veh_taxi_1", kind: "RULES", reason: ROUTE_HOLD_REASONS.CREW }], "v", 1);
    expect(view.options).toEqual([]);
    expect(view.rejected.map((r) => r.vehicleId)).toEqual(["veh_vsl_1", "veh_taxi_1"]);
  });
});

describe("planPlaceWrite", () => {
  const current = new Map<string, CurrentTrip>(
    ["trip_1", "trip_2", "trip_3", "trip_4"].map((id) => [
      id,
      { id, status: id === "trip_1" ? "PLANNED" : "ASSIGNED", sharingStatus: "NOT_PROPOSED", pickupAddress: `départ ${id}`, dropoffAddress: `arrivée ${id}` },
    ]),
  );
  const vehicles = new Map<string, VehicleCrew>([
    ["veh_taxi_1", { id: "veh_taxi_1", type: "TAXI", defaultDriverId: "drv-1", defaultCrewMateId: null }],
    ["veh_vsl_1", { id: "veh_vsl_1", type: "VSL", defaultDriverId: "drv-2", defaultCrewMateId: null }],
  ]);
  const now = new Date("2026-11-10T08:00:00Z");

  it("rewrites the target route and gives every trip of it its result, the placed one assigned", () => {
    const [option] = placed().options;
    const write = planPlaceWrite({ option: option!, fromVehicleId: null, stored: new Map([["veh_taxi_1", { id: "route-taxi" }]]), vehicles, current, now });
    expect(write.deletedRouteIds).toEqual([]);
    expect(write.routes.map((r) => r.routeId)).toEqual(["route-taxi"]);
    const row = write.routes[0]!.row;
    expect(row.stops.map((s) => `${s.sequence}:${s.tripId}/${s.kind}`)).toEqual([
      "0:trip_1/PICKUP",
      "1:trip_3/PICKUP",
      "2:trip_1/DROPOFF",
      "3:trip_3/DROPOFF",
      "4:trip_2/PICKUP",
      "5:trip_4/PICKUP",
      "6:trip_4/DROPOFF",
      "7:trip_2/DROPOFF",
    ]);
    expect(row.stops[0]?.address).toBe("départ trip_1");
    expect(row).toMatchObject({ revenue: 160.4, margin: -38.36, breakStartMinute: 758 });
    const placedTrip = write.trips.find((t) => t.tripId === "trip_1");
    expect(placedTrip).toMatchObject({ vehicleId: "veh_taxi_1", data: { status: "ASSIGNED", plannedPickupMinute: 368, shared: true } });
    // Newly shared: proposed to the patient (décret 2025-202), timestamped.
    expect(placedTrip?.data.sharingStatus).toBe("PROPOSED");
    expect(write.trips.map((t) => t.tripId).sort()).toEqual(["trip_1", "trip_2", "trip_3", "trip_4"]);
  });

  it("creates the route of a vehicle without one, and deletes the route a move leaves empty", () => {
    const [option] = placed().options;
    const moved = { ...option!, routes: option!.routes.map((r) => ({ ...r, vehicleId: "veh_vsl_1" })), trips: option!.trips.map((t) => ({ ...t, vehicleId: "veh_vsl_1" })) };
    const write = planPlaceWrite({
      option: moved,
      fromVehicleId: "veh_taxi_1",
      stored: new Map([["veh_taxi_1", { id: "route-taxi" }]]),
      vehicles,
      current,
      now,
    });
    expect(write.routes.map((r) => [r.routeId, r.row.vehicleId, r.row.driverId])).toEqual([[null, "veh_vsl_1", "drv-2"]]);
    expect(write.deletedRouteIds).toEqual(["route-taxi"]);
  });
});

describe("violationsAfterPlace", () => {
  const request = { trips: [{ id: "trip_1", patientId: "p1" }, { id: "trip_2", patientId: "p1" }, { id: "trip_7", patientId: "p7" }] } as unknown as Pick<
    DayRequest,
    "trips"
  >;
  const violation = (code: Violation["code"], tripId: string | null, vehicleId: string | null): Violation => ({ code, message: code, tripId, vehicleId });

  it("replaces the violations of the changed routes, their trips and their patients' total wait by the option's, keeps the others", () => {
    const stored = [
      violation("TIME_WINDOW", "trip_1", "veh_vsl_1"),
      violation("BREAK", null, "veh_taxi_1"),
      violation("TOTAL_WAIT", "trip_2", "veh_amb_1"),
      violation("DETOUR", "trip_7", "veh_amb_1"),
    ];
    const option = { routes: [{ vehicleId: "veh_taxi_1" }], trips: [{ tripId: "trip_1" }], violations: [violation("RIDE_TIME", "trip_1", "veh_taxi_1")] };
    expect(violationsAfterPlace(stored, option as never, "veh_vsl_1", request)).toEqual([
      violation("DETOUR", "trip_7", "veh_amb_1"),
      violation("RIDE_TIME", "trip_1", "veh_taxi_1"),
    ]);
  });
});

describe("validated or started day", () => {
  it("creates a validated route only when every route of the day is validated", () => {
    expect(newRouteStatus([])).toBe("PROPOSED");
    expect(newRouteStatus([{ status: "VALIDATED" }, { status: "VALIDATED" }])).toBe("VALIDATED");
    expect(newRouteStatus([{ status: "VALIDATED" }, { status: "PROPOSED" }])).toBe("PROPOSED");
  });

  it("asks before changing the roadmaps of a validated or started day, naming the vehicles", () => {
    expect(placeQuestion({ validated: false, started: false }, ["VSL 1"])).toBeNull();
    expect(placeQuestion({ validated: true, started: false }, ["VSL 1"])).toBe(
      "Planning validé\u00a0: la feuille de route de VSL 1 change dès l'enregistrement, prévenez les chauffeurs. Appliquer quand même\u202f?",
    );
    expect(placeQuestion({ validated: true, started: true }, ["VSL 1", "Taxi 2"])).toBe(
      "Planning validé et journée commencée\u00a0: les feuilles de route de VSL 1 et Taxi 2 changent dès l'enregistrement, prévenez les chauffeurs. Appliquer quand même\u202f?",
    );
    expect(placeQuestion({ validated: false, started: true }, ["VSL 1"])).toMatch(/^Journée commencée\u00a0: /);
  });
});

describe("placedMessage", () => {
  it("says where the trip went, what it costs and that nothing else moved", () => {
    expect(placedMessage({ patient: "Jeanne Martin", vehicleLabel: "VSL 1", fromLabel: "Taxi 2", option: { pickupMin: 552, deltaKm: 6.24, deltaMargin: 18.4 } })).toBe(
      "Course de Jeanne Martin placée sur VSL 1 et figée\u00a0: prise en charge 09:12, +6,2\u00a0km, marge\u00a0+18\u00a0€. Seules les tournées de VSL 1 et Taxi 2 ont changé.",
    );
    expect(placedMessage({ patient: "Jeanne Martin", vehicleLabel: "VSL 1", fromLabel: null, option: { pickupMin: 552, deltaKm: -2, deltaMargin: 0 } })).toMatch(
      /^Course de Jeanne Martin placée sur VSL 1 et figée\u00a0: prise en charge 09:12, [\u2212-]2,0\u00a0km, marge inchangée\. Seule la tournée de VSL 1 a changé\.$/,
    );
  });
});

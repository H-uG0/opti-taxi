import { describe, expect, it } from "vitest";
import { planningFixture, tripView, vehicleRow } from "@/test/planning-fixtures";
import {
  addDraftMove,
  changedVehicles,
  draftCountText,
  dragIssue,
  dropIssue,
  parseStoredMoves,
  removeDraftMove,
  rowsWithDraft,
  tripsWithDraft,
  vehicleOfTrip,
  withOptionRoutes,
  withoutTrip,
  type DraftSequence,
} from "./draft";

const route = (vehicleId: string, trips: string[]): DraftSequence => ({
  vehicleId,
  stops: trips.flatMap((tripId) => [
    { tripId, kind: "PICKUP" as const },
    { tripId, kind: "DROPOFF" as const },
  ]),
});

describe("the list of moves", () => {
  const home = (tripId: string) => ({ a: "taxi1", b: "vsl1", c: null })[tripId] ?? null;

  it("keeps the trip's last drop, and forgets a drop back where the plan in place has it", () => {
    let moves = addDraftMove([], { tripId: "a", toVehicleId: "vsl1" }, home);
    moves = addDraftMove(moves, { tripId: "b", toVehicleId: null }, home);
    moves = addDraftMove(moves, { tripId: "a", toVehicleId: "amb1" }, home);
    expect(moves).toEqual([
      { tripId: "b", toVehicleId: null },
      { tripId: "a", toVehicleId: "amb1" },
    ]);
    expect(addDraftMove(moves, { tripId: "a", toVehicleId: "taxi1" }, home)).toEqual([{ tripId: "b", toVehicleId: null }]);
    expect(addDraftMove([], { tripId: "c", toVehicleId: null }, home)).toEqual([]);
    expect(removeDraftMove(moves, "b")).toEqual([{ tripId: "a", toVehicleId: "amb1" }]);
  });

  it("reads the moves kept for a date, anything malformed as none", () => {
    expect(parseStoredMoves('[{"tripId":"a","toVehicleId":"vsl1"},{"tripId":"b","toVehicleId":null}]')).toEqual([
      { tripId: "a", toVehicleId: "vsl1" },
      { tripId: "b", toVehicleId: null },
    ]);
    expect(parseStoredMoves('[{"tripId":1},{"toVehicleId":"x"},"z"]')).toEqual([]);
    expect(parseStoredMoves("{")).toEqual([]);
    expect(parseStoredMoves(null)).toEqual([]);
  });

  it("counts the moves not saved", () => {
    expect(draftCountText(1)).toBe("1 modification non enregistrée");
    expect(draftCountText(3)).toBe("3 modifications non enregistrées");
  });
});

describe("the stop sequences as the moves edit them", () => {
  const routes = [route("taxi1", ["a", "b"]), route("vsl1", ["c"])];

  it("takes a trip out of its route, a route left empty going", () => {
    expect(vehicleOfTrip(routes, "c")).toBe("vsl1");
    expect(withoutTrip(routes, "a")).toEqual([route("taxi1", ["b"])].concat([route("vsl1", ["c"])]));
    expect(withoutTrip(routes, "c")).toEqual([route("taxi1", ["a", "b"])]);
  });

  it("takes an /insert option: the target's and the source's routes replaced, an emptied source gone", () => {
    const moved = withOptionRoutes(routes, { routes: [route("vsl1", ["c", "a"]), route("taxi1", ["b"])] }, "taxi1");
    expect(moved).toEqual([route("taxi1", ["b"]), route("vsl1", ["c", "a"])]);
    const emptied = withOptionRoutes(routes, { routes: [route("taxi1", ["a", "b", "c"])] }, "vsl1");
    expect(emptied).toEqual([route("taxi1", ["a", "b", "c"])]);
    const created = withOptionRoutes(routes, { routes: [route("amb1", ["c"])] }, "vsl1");
    expect(created).toEqual([route("taxi1", ["a", "b"]), route("amb1", ["c"])]);
  });

  it("finds the vehicles whose sequence changed", () => {
    const after = [route("taxi1", ["b"]), route("vsl1", ["c", "a"]), route("amb1", ["d"])];
    expect([...changedVehicles(routes, after)].sort()).toEqual(["amb1", "taxi1", "vsl1"]);
    expect([...changedVehicles(routes, routes)]).toEqual([]);
  });
});

describe("the board with the draft", () => {
  const { trips, vehicles } = planningFixture();
  const draft = {
    routes: [
      {
        vehicleId: "vsl-1",
        route: {
          startMinute: 395,
          endMinute: 480,
          distanceKm: 20,
          emptyKm: 5,
          revenue: 40,
          cost: 20,
          margin: 20,
          breakStartMinute: null,
          breakEndMinute: null,
          stops: [
            { tripId: "trip-c", kind: "PICKUP" as const, lat: 43.3, lng: 5.4, arrivalMinute: 405, startMinute: 405, departureMinute: 410, loadAfter: 1 },
            { tripId: "trip-c", kind: "DROPOFF" as const, lat: 43.3, lng: 5.4, arrivalMinute: 430, startMinute: 430, departureMinute: 435, loadAfter: 0 },
          ],
        },
      },
      { vehicleId: "taxi-1", route: null },
    ],
    trips: [
      { tripId: "trip-c", vehicleId: "vsl-1", pickupMinute: 405, dropoffMinute: 430, shared: false, coPassengerTripIds: [], estimatedRevenue: 22, detourKm: 0 },
      { tripId: "trip-a", vehicleId: null, pickupMinute: null, dropoffMinute: null, shared: false, coPassengerTripIds: [], estimatedRevenue: null, detourKm: null },
    ],
  };

  it("draws the draft's routes on their rows, with the stops' addresses", () => {
    const rows = rowsWithDraft(vehicles, draft, (tripId, kind) => `${kind} ${tripId}`);
    const vsl = rows.find((r) => r.id === "vsl-1");
    expect(vsl?.route).toMatchObject({ id: "brouillon-vsl-1", status: "PROPOSED", tripCount: 1, startMinute: 395, margin: 20 });
    expect(vsl?.route?.stops.map((s) => [s.id, s.address, s.completed])).toEqual([
      ["brouillon-vsl-1-0", "PICKUP trip-c", false],
      ["brouillon-vsl-1-1", "DROPOFF trip-c", false],
    ]);
    expect(rows.find((r) => r.id === "taxi-1")?.route).toBeNull();
    expect(rows.find((r) => r.id === "amb-1")).toBe(vehicles[2]);
    expect(rowsWithDraft(vehicles, null, () => "")).toEqual(vehicles);
  });

  it("gives the trips their draft vehicle and times", () => {
    const shown = tripsWithDraft(trips, draft);
    expect(shown["trip-c"]).toMatchObject({ vehicleId: "vsl-1", plannedPickupMinute: 405, estimatedRevenue: 22 });
    expect(shown["trip-a"]).toMatchObject({ vehicleId: null, plannedPickupMinute: null });
    expect(shown["trip-b"]).toBe(trips["trip-b"]);
  });
});

describe("what can be dragged, and where", () => {
  it("drags an active trip of a route not started, never an exceptional ambulance", () => {
    expect(dragIssue(tripView(), false)).toBeNull();
    expect(dragIssue(tripView({ status: "CANCELLED" }), false)).toMatch(/annulée/);
    expect(dragIssue(tripView({ status: "PICKED_UP" }), false)).toMatch(/commencée/);
    expect(dragIssue(tripView({ exceptionalAmbulance: true }), false)).toMatch(/Défiger/);
    expect(dragIssue(tripView(), true)).toMatch(/Tournée commencée/);
  });

  it("drops on an available vehicle of an allowed type, or on « À placer » when the trip has a vehicle", () => {
    const trip = tripView({ vehicleId: "taxi-1", allowedVehicleTypes: ["TAXI", "VSL"] });
    const row = (overrides: Partial<ReturnType<typeof vehicleRow>> = {}, started = false) => ({ ...vehicleRow(overrides), started });
    expect(dropIssue(trip, row({ id: "vsl-1", type: "VSL" }))).toBeNull();
    expect(dropIssue(trip, row())).toBe("Déjà sur ce véhicule.");
    expect(dropIssue(trip, row({ id: "amb-1", type: "AMBULANCE" }))).toMatch(/non autorisé/);
    expect(dropIssue(trip, row({ id: "vsl-2", type: "VSL", available: false, label: "VSL 2" }))).toBe("VSL 2 est indisponible ce jour.");
    expect(dropIssue(trip, row({ id: "vsl-1", type: "VSL", label: "VSL 1" }, true))).toBe("VSL 1 a une tournée commencée.");
    expect(dropIssue(trip, null)).toBeNull();
    expect(dropIssue(tripView({ vehicleId: null }), null)).toBe("Déjà à placer.");
  });
});

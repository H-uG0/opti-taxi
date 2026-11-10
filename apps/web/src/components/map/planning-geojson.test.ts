import { describe, expect, it } from "vitest";
import {
  allPoints,
  boundsOf,
  depotsCollection,
  routesCollection,
  selectionCollection,
  selectionKey,
  shouldFitSelection,
  stopsCollection,
  unassignedCollection,
  violationsCollection,
  type MapTrip,
  type MapVehicle,
} from "./planning-geojson";

const depot = { lat: 43.3, lng: 5.37, label: "Marseille" };
const vehicles: MapVehicle[] = [
  {
    id: "v1",
    label: "Taxi 1",
    type: "TAXI",
    color: "#c27c0e",
    depot,
    stops: [
      { tripId: "a", kind: "PICKUP", lat: 43.31, lng: 5.39, title: "07:00", violation: true },
      { tripId: "a", kind: "DROPOFF", lat: 43.52, lng: 5.44, title: "07:30" },
    ],
  },
  { id: "v2", label: "Taxi 2", type: "TAXI", color: "#8a5a0a", depot, stops: [] },
];
const trips: MapTrip[] = [
  { id: "a", title: "A", pickup: { lat: 43.31, lng: 5.39 }, dropoff: { lat: 43.52, lng: 5.44 }, vehicleId: "v1" },
  { id: "b", title: "B", pickup: { lat: 44.2, lng: 5.94 }, dropoff: { lat: 44.56, lng: 6.08 }, vehicleId: null, violation: true },
];

describe("planning map layers", () => {
  it("draws one closed polyline per route, depot first and last, in [lng, lat]", () => {
    const routes = routesCollection(vehicles);
    expect(routes.features).toHaveLength(1);
    expect(routes.features[0]?.geometry.coordinates).toEqual([
      [5.37, 43.3],
      [5.39, 43.31],
      [5.44, 43.52],
      [5.37, 43.3],
    ]);
    expect(routes.features[0]?.properties).toEqual({ vehicleId: "v1", color: "#c27c0e", title: "Taxi 1" });
  });

  it("lists stops and shared depots once", () => {
    expect(stopsCollection(vehicles).features.map((f) => f.properties.kind)).toEqual(["PICKUP", "DROPOFF"]);
    // What the stop's marker needs: its shape (the vehicle's type), filled or hollow, the vehicle's color.
    expect(stopsCollection([{ ...vehicles[0]!, type: "AMBULANCE", color: "#1D4ED8" }]).features[0]?.properties).toMatchObject({
      kind: "PICKUP",
      type: "AMBULANCE",
      color: "#1d4ed8",
    });
    const depots = depotsCollection(vehicles);
    expect(depots.features).toHaveLength(1);
    expect(depots.features[0]?.properties.title).toBe("Dépôt Marseille : Taxi 1, Taxi 2");
  });

  it("draws a trip without a vehicle from its pick-up to its drop-off, unlike a route's stops", () => {
    const unassigned = unassignedCollection(trips);
    expect(unassigned.features.map((f) => [f.properties.tripId, f.properties.role, f.geometry.type])).toEqual([
      ["b", "line", "LineString"],
      ["b", "pickup", "Point"],
      ["b", "dropoff", "Point"],
    ]);
    expect(unassigned.features[0]?.geometry.coordinates).toEqual([
      [5.94, 44.2],
      [6.08, 44.56],
    ]);
    expect(unassigned.features[1]?.properties.title).toBe("Prise en charge · B (à placer)");
  });

  it("draws the trips of a day not optimized yet as plain pick-ups « à planifier », not as trips left without a vehicle", () => {
    const pending = unassignedCollection(trips, false);
    expect(pending.features.map((f) => [f.properties.tripId, f.properties.role, f.geometry.type])).toEqual([["b", "pending", "Point"]]);
    expect(pending.features[0]?.properties.title).toBe("Prise en charge · B (à planifier)");
  });

  it("puts a warning sign at the pick-up of each trip in violation, once", () => {
    const signs = violationsCollection(vehicles, [...trips, { ...trips[0]!, violation: true }]);
    expect(signs.features.map((f) => [f.properties.tripId, f.geometry.coordinates])).toEqual([
      ["a", [5.39, 43.31]],
      ["b", [5.94, 44.2]],
    ]);
  });

  it("builds the selection and the bounds", () => {
    expect(selectionCollection(null).features).toEqual([]);
    expect(selectionCollection(trips[1] ?? null).features.map((f) => f.properties.role)).toEqual(["line", "pickup", "dropoff"]);
    expect(boundsOf([])).toBeNull();
    expect(boundsOf(allPoints(vehicles, trips))).toEqual([
      [5.37, 43.3],
      [6.08, 44.56],
    ]);
    // Narrowed to depots: the trips without a vehicle stay out of the frame (unless nothing else is shown).
    expect(boundsOf(allPoints(vehicles, trips, false))).toEqual([
      [5.37, 43.3],
      [5.44, 43.52],
    ]);
    expect(allPoints([], trips, false)).toHaveLength(4);
  });
});

describe("map fit on selection", () => {
  const trip = selectionKey("t1", "v1");

  it("fits when a new trip or vehicle is selected from the timeline or the list", () => {
    expect(shouldFitSelection(null, trip, false)).toBe(true);
    expect(shouldFitSelection(selectionKey(null, "v1"), trip, false)).toBe(true);
    expect(shouldFitSelection(trip, selectionKey("t2", "v1"), false)).toBe(true);
  });

  it("keeps the regulator's view when the data of the same selection is refreshed after an action", () => {
    expect(shouldFitSelection(trip, trip, false)).toBe(false);
  });

  it("does not move the map for a click made on the map, nor when nothing is selected", () => {
    expect(shouldFitSelection(null, trip, true)).toBe(false);
    expect(shouldFitSelection(trip, selectionKey(null, null), false)).toBe(false);
  });

  it("fits again when the selected trip moved to another vehicle", () => {
    expect(shouldFitSelection(trip, selectionKey("t1", "v2"), false)).toBe(true);
  });
});

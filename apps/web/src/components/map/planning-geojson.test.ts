import { describe, expect, it } from "vitest";
import {
  allPoints,
  boundsOf,
  depotsCollection,
  routesCollection,
  selectionCollection,
  stopsCollection,
  unassignedCollection,
  type MapTrip,
  type MapVehicle,
} from "./planning-geojson";

const depot = { lat: 43.3, lng: 5.37, label: "Marseille" };
const vehicles: MapVehicle[] = [
  {
    id: "v1",
    label: "Taxi 1",
    color: "#c27c0e",
    depot,
    stops: [
      { tripId: "a", kind: "PICKUP", lat: 43.31, lng: 5.39, title: "07:00" },
      { tripId: "a", kind: "DROPOFF", lat: 43.52, lng: 5.44, title: "07:30" },
    ],
  },
  { id: "v2", label: "Taxi 2", color: "#8a5a0a", depot, stops: [] },
];
const trips: MapTrip[] = [
  { id: "a", title: "A", pickup: { lat: 43.31, lng: 5.39 }, dropoff: { lat: 43.52, lng: 5.44 }, vehicleId: "v1" },
  { id: "b", title: "B", pickup: { lat: 44.2, lng: 5.94 }, dropoff: { lat: 44.56, lng: 6.08 }, vehicleId: null },
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

  it("lists stops, shared depots once, and unassigned pick-ups", () => {
    expect(stopsCollection(vehicles).features.map((f) => f.properties.kind)).toEqual(["PICKUP", "DROPOFF"]);
    const depots = depotsCollection(vehicles);
    expect(depots.features).toHaveLength(1);
    expect(depots.features[0]?.properties.title).toBe("Dépôt Marseille : Taxi 1, Taxi 2");
    expect(unassignedCollection(trips).features.map((f) => f.properties.tripId)).toEqual(["b"]);
  });

  it("builds the selection and the bounds", () => {
    expect(selectionCollection(null).features).toEqual([]);
    expect(selectionCollection(trips[1] ?? null).features.map((f) => f.properties.role)).toEqual(["line", "pickup", "dropoff"]);
    expect(boundsOf([])).toBeNull();
    expect(boundsOf(allPoints(vehicles, trips))).toEqual([
      [5.37, 43.3],
      [6.08, 44.56],
    ]);
  });
});

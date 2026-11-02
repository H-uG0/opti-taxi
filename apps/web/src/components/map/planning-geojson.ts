/**
 * GeoJSON layers of the planning map, built from plain planning data.
 * Pure (no MapLibre import) so it can be unit-tested.
 */

export type MapPoint = { lat: number; lng: number };

export type MapStop = MapPoint & {
  tripId: string;
  kind: "PICKUP" | "DROPOFF";
  /** Hover text: time, kind, patient. */
  title: string;
};

export type MapVehicle = {
  id: string;
  label: string;
  color: string;
  depot: MapPoint & { label: string };
  /** Ordered stops of its route (empty when the vehicle has no route). */
  stops: MapStop[];
};

export type MapTrip = {
  id: string;
  title: string;
  pickup: MapPoint;
  dropoff: MapPoint;
  vehicleId: string | null;
};

type Position = [number, number];
type PointGeometry = { type: "Point"; coordinates: Position };
type LineGeometry = { type: "LineString"; coordinates: Position[] };
export type Feature<G, P> = { type: "Feature"; geometry: G; properties: P };
export type FeatureCollection<G, P> = { type: "FeatureCollection"; features: Array<Feature<G, P>> };

const position = (p: MapPoint): Position => [p.lng, p.lat];

/** One straight-line polyline per route: depot -> stops -> depot. */
export function routesCollection(
  vehicles: MapVehicle[],
): FeatureCollection<LineGeometry, { vehicleId: string; color: string; title: string }> {
  return {
    type: "FeatureCollection",
    features: vehicles
      .filter((v) => v.stops.length > 0)
      .map((v) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [position(v.depot), ...v.stops.map(position), position(v.depot)] },
        properties: { vehicleId: v.id, color: v.color, title: v.label },
      })),
  };
}

export function stopsCollection(
  vehicles: MapVehicle[],
): FeatureCollection<PointGeometry, { tripId: string; vehicleId: string; kind: string; color: string; title: string }> {
  return {
    type: "FeatureCollection",
    features: vehicles.flatMap((v) =>
      v.stops.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: position(s) },
        properties: { tripId: s.tripId, vehicleId: v.id, kind: s.kind, color: v.color, title: s.title },
      })),
    ),
  };
}

/** Depots, one feature per location (vehicles sharing a depot are listed together). */
export function depotsCollection(
  vehicles: MapVehicle[],
): FeatureCollection<PointGeometry, { title: string; vehicleIds: string }> {
  const byPlace = new Map<string, { point: MapPoint; label: string; vehicles: MapVehicle[] }>();
  for (const v of vehicles) {
    const key = `${v.depot.lat.toFixed(5)},${v.depot.lng.toFixed(5)}`;
    const entry = byPlace.get(key) ?? { point: v.depot, label: v.depot.label, vehicles: [] };
    entry.vehicles.push(v);
    byPlace.set(key, entry);
  }
  return {
    type: "FeatureCollection",
    features: [...byPlace.values()].map((d) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: position(d.point) },
      properties: {
        title: `Dépôt ${d.label} : ${d.vehicles.map((v) => v.label).join(", ")}`,
        vehicleIds: d.vehicles.map((v) => v.id).join(","),
      },
    })),
  };
}

/** Pick-up points of trips without a vehicle. */
export function unassignedCollection(trips: MapTrip[]): FeatureCollection<PointGeometry, { tripId: string; title: string }> {
  return {
    type: "FeatureCollection",
    features: trips
      .filter((t) => t.vehicleId === null)
      .map((t) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: position(t.pickup) },
        properties: { tripId: t.id, title: `${t.title} (non affectée)` },
      })),
  };
}

/** Selected trip: pick-up -> drop-off line and both end points. */
export function selectionCollection(
  trip: MapTrip | null,
): FeatureCollection<PointGeometry | LineGeometry, { role: "line" | "pickup" | "dropoff" }> {
  if (!trip) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [position(trip.pickup), position(trip.dropoff)] },
        properties: { role: "line" },
      },
      { type: "Feature", geometry: { type: "Point", coordinates: position(trip.pickup) }, properties: { role: "pickup" } },
      { type: "Feature", geometry: { type: "Point", coordinates: position(trip.dropoff) }, properties: { role: "dropoff" } },
    ],
  };
}

/** [[west, south], [east, north]] of the points, or null when there is none. */
export function boundsOf(points: MapPoint[]): [Position, Position] | null {
  if (points.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}

/** Every point worth showing when nothing is selected. */
export function allPoints(vehicles: MapVehicle[], trips: MapTrip[]): MapPoint[] {
  return [
    ...vehicles.map((v) => v.depot),
    ...vehicles.flatMap((v) => v.stops),
    ...trips.flatMap((t) => [t.pickup, t.dropoff]),
  ];
}

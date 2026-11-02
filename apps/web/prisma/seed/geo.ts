/** Small geodesy helpers for placing fictitious addresses around real town centres. */
import type { Rng } from "./random";

export type LatLng = { lat: number; lng: number };

const KM_PER_DEGREE_LAT = 111.32;

/** Rounds a coordinate to 5 decimals (about 1 m), enough for routing. */
function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** Point at `distanceKm` from `origin` towards `bearingDeg` (0 = north, 90 = east). Flat-earth approximation, fine below ~50 km. */
export function offset(origin: LatLng, bearingDeg: number, distanceKm: number): LatLng {
  const bearing = (bearingDeg * Math.PI) / 180;
  const kmPerDegreeLng = KM_PER_DEGREE_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: roundCoord(origin.lat + (distanceKm * Math.cos(bearing)) / KM_PER_DEGREE_LAT),
    lng: roundCoord(origin.lng + (distanceKm * Math.sin(bearing)) / kmPerDegreeLng),
  };
}

/** Great-circle distance in km (haversine). */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Random point between `minKm` and `maxKm` from `origin`, in any direction. */
export function jitter(rng: Rng, origin: LatLng, minKm: number, maxKm: number): LatLng {
  return offset(origin, rng.float(0, 360), rng.float(minKm, maxKm));
}

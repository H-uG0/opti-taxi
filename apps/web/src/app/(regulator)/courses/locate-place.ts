import "server-only";
import { LOW_GEOCODE_SCORE } from "@/components/address/address-utils";
import type { SessionUser } from "@/lib/auth";
import { allowGeocodeSearch, bestMatch, GEOCODE_THROTTLED_MESSAGE, geocoderEnabled, searchAddress } from "@/lib/geocode";
import { logError } from "@/lib/log";

export type LocatedPlace = { address: string; lat: number; lng: number };

/** Form fields the answer points at when the place cannot be found. */
export type PlaceFields = { address: string; lat: string };

export type LocateResult = { ok: true; place: LocatedPlace } | { ok: false; field: string; message: string };

const OUTSIDE_FRANCE_MESSAGE = "Adresse localisée hors de France métropolitaine : précisez-la ou saisissez les coordonnées.";

/**
 * A place typed on a trip (free destination of a private trip, one-off address
 * of « Modifier la course »): typed coordinates (already checked in
 * metropolitan France by the form parser), or the geocoded address (one search
 * taken from the user's allowance; only the address is sent, never a name).
 */
export async function locatePlace(
  user: Pick<SessionUser, "id">,
  address: string,
  lat: number | undefined,
  lng: number | undefined,
  fields: PlaceFields,
): Promise<LocateResult> {
  if (lat !== undefined && lng !== undefined) return { ok: true, place: { address, lat, lng } };
  if (!geocoderEnabled()) {
    return { ok: false, field: fields.lat, message: "Géocodage indisponible : saisissez la latitude et la longitude." };
  }
  if (!allowGeocodeSearch(user.id)) return { ok: false, field: fields.address, message: GEOCODE_THROTTLED_MESSAGE };
  try {
    // The stored point goes to the optimizer: bestMatch checks it again against
    // the metropolitan France ranges, whatever the parser kept.
    const match = bestMatch(await searchAddress(address, 1), LOW_GEOCODE_SCORE);
    if (match.status === "outside_france") return { ok: false, field: fields.address, message: OUTSIDE_FRANCE_MESSAGE };
    if (match.status === "not_found") {
      return { ok: false, field: fields.address, message: "Adresse introuvable ou imprécise : précisez-la ou saisissez les coordonnées." };
    }
    const best = match.result;
    return { ok: true, place: { address: best.label, lat: best.lat, lng: best.lng } };
  } catch (error) {
    logError("[courses] geocodeAddress failed", error);
    return { ok: false, field: fields.lat, message: "Le géocodage n'a pas répondu : saisissez la latitude et la longitude." };
  }
}

/** The coordinates are the stored point, as a form printed them (6 decimals). */
export function isStoredPoint(stored: LocatedPlace, lat: number, lng: number): boolean {
  return Math.abs(lat - stored.lat) < 1e-6 && Math.abs(lng - stored.lng) < 1e-6;
}

/**
 * A place changed in « Modifier la course », whose form showed the stored one
 * (`stored`, null when it showed none). Coordinates still those of the stored
 * point while the address changed are stale (the form prefilled them): the new
 * address is located as if they had been left empty, never saved with the old
 * point (the optimizer and the driver's GPS links read the point).
 */
export async function locateEditedPlace(
  user: Pick<SessionUser, "id">,
  stored: LocatedPlace | null,
  address: string,
  lat: number | undefined,
  lng: number | undefined,
  fields: PlaceFields,
): Promise<LocateResult> {
  const stale = stored !== null && address !== stored.address && lat !== undefined && lng !== undefined && isStoredPoint(stored, lat, lng);
  if (!stale) return locatePlace(user, address, lat, lng, fields);
  if (!geocoderEnabled()) {
    return {
      ok: false,
      field: fields.lat,
      message: "L'adresse a changé mais pas ses coordonnées\u00a0: saisissez la latitude et la longitude de la nouvelle adresse.",
    };
  }
  return locatePlace(user, address, undefined, undefined, fields);
}

/**
 * Depot form: validation, normalisation and the mapping between a Depot row
 * and form values. Pure module (unit-tested).
 *
 * A depot is where the routes of its vehicles start and end, and where its
 * staff report for duty. Its coordinates are entered by hand (or pasted from a
 * map): the optimizer computes every drive from them.
 */
import { z } from "zod";
import type { Depot } from "@prisma/client";
import { numberField, optionalText, parseDecimal, requiredText, type FormValues } from "@/lib/forms";
import { formatShortDate } from "@/lib/time";
import { upcomingRouteDates, type UpcomingRoute } from "@/app/(regulator)/vehicules/_lib/upcoming-routes";

const MAX_LISTED_DATES = 5;

/** Metropolitan France (Corsica included): catches swapped or mistyped coordinates. */
export const FRANCE_BOUNDS = { minLat: 41, maxLat: 51.2, minLng: -5.3, maxLng: 9.7 } as const;

export function isInFrance(lat: number, lng: number): boolean {
  return (
    lat >= FRANCE_BOUNDS.minLat && lat <= FRANCE_BOUNDS.maxLat && lng >= FRANCE_BOUNDS.minLng && lng <= FRANCE_BOUNDS.maxLng
  );
}

/**
 * A "lat, lng" pair pasted from a map ("43.29651, 5.36978", "43,2965 ; 5,3698").
 * Returns null when the text is not exactly two coordinates.
 */
export function parseCoordinatePair(text: string): { lat: string; lng: string } | null {
  const match = /^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const [, lat = "", lng = ""] = match;
  const latNum = parseDecimal(lat);
  const lngNum = parseDecimal(lng);
  if (latNum === undefined || lngNum === undefined || Number.isNaN(latNum) || Number.isNaN(lngNum)) return null;
  if (Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) return null;
  return { lat, lng };
}

export const depotSchema = z
  .object({
    name: requiredText(60),
    address: requiredText(200),
    lat: numberField({ min: -90, max: 90 }),
    lng: numberField({ min: -180, max: 180 }),
    notes: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (!isInFrance(v.lat, v.lng)) {
      ctx.addIssue({
        code: "custom",
        path: ["lat"],
        message: isInFrance(v.lng, v.lat)
          ? "Latitude et longitude semblent inversées (Marseille : latitude 43,30 ; longitude 5,37)."
          : "Coordonnées hors de France métropolitaine : vérifiez la latitude et la longitude.",
      });
    }
  });

export type DepotInput = z.output<typeof depotSchema>;

type DepotRecord = Pick<Depot, "name" | "address" | "lat" | "lng" | "notes">;

/** Form values of an existing depot, or of a new one. */
export function depotFormValues(depot?: DepotRecord): FormValues {
  if (!depot) return { name: "", address: "", lat: "", lng: "", notes: "" };
  return {
    name: depot.name,
    address: depot.address,
    // Coordinates keep the dot used by map tools.
    lat: String(depot.lat),
    lng: String(depot.lng),
    notes: depot.notes ?? "",
  };
}

/** Did the place move? Then the routes already computed start from the old one. */
export function depotMoved(before: Pick<Depot, "lat" | "lng">, after: Pick<DepotInput, "lat" | "lng">): boolean {
  return before.lat !== after.lat || before.lng !== after.lng;
}

/**
 * "2 tournées à venir (03/11/2026, 04/11/2026) partent encore de l'ancienne
 * position du dépôt : relancez l'optimisation de ces jours depuis le
 * planning." Null without upcoming route.
 */
export function movedDepotNotice(routes: readonly UpcomingRoute[]): string | null {
  const count = routes.length;
  if (count === 0) return null;
  const many = count > 1;
  const dates = upcomingRouteDates(routes);
  const listed = dates.slice(0, MAX_LISTED_DATES).map(formatShortDate).join(", ");
  const dateText = dates.length > MAX_LISTED_DATES ? `${listed}…` : listed;
  const days = dates.length > 1 ? "ces jours" : "ce jour";
  return (
    `Dépôt enregistré. ${count} tournée${many ? "s" : ""} à venir (${dateText}) ${many ? "partent" : "part"} encore de ` +
    `l'ancienne position du dépôt : relancez l'optimisation de ${days} depuis le planning.`
  );
}

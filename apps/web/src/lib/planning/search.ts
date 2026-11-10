/**
 * Search of the planning screen (« / »): a patient, a vehicle, a driver or a
 * facility among the day's trips and vehicles, on the client. Pure: the
 * results are ranked here and the search box only shows them.
 */
import { DIRECTION_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";
import type { TripView, VehicleRowView } from "./types";

export type SearchResult =
  | { kind: "trip"; id: string; title: string; detail: string; vehicleId: string | null }
  | { kind: "vehicle"; id: string; title: string; detail: string; vehicleId: string };

/** Lowercase, accents and punctuation removed, spaces collapsed: « Hélène » and « helene » match. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How well every word of the query matches `text` (normalized): 3 when the
 * text starts with the query, 2 when every word starts a word of the text,
 * 1 when every word is found inside it, 0 otherwise.
 */
export function matchScore(text: string, query: string): number {
  if (!query) return 0;
  const words = query.split(" ");
  if (!words.every((w) => text.includes(w))) return 0;
  if (text.startsWith(query)) return 3;
  const textWords = text.split(" ");
  return words.every((w) => textWords.some((t) => t.startsWith(w))) ? 2 : 1;
}

function tripWhen(trip: TripView): string {
  return trip.direction === "OUTBOUND"
    ? `${DIRECTION_LABELS.OUTBOUND}, RDV ${formatMinute(trip.appointmentMinute)}`
    : `${DIRECTION_LABELS.RETURN}, fin ${formatMinute(trip.readyMinute)}`;
}

function tripMinute(trip: TripView): number {
  return trip.plannedPickupMinute ?? trip.appointmentMinute ?? trip.readyMinute ?? 0;
}

/**
 * Trips whose patient or facility matches, then vehicles whose label,
 * registration, depot or crew matches, best matches first (trips of the same
 * score in time order), at most `limit`. Under 2 characters: nothing.
 */
export function searchPlanning(
  query: string,
  trips: readonly TripView[],
  vehicles: readonly VehicleRowView[],
  limit = 12,
): SearchResult[] {
  const q = normalizeText(query);
  if (q.length < 2) return [];
  const labelOf = new Map(vehicles.map((v) => [v.id, v.label]));

  const tripHits: Array<{ score: number; minute: number; result: SearchResult }> = [];
  for (const trip of trips) {
    const byPatient = matchScore(normalizeText(trip.patientName), q);
    const byFacility = trip.facilityName ? matchScore(normalizeText(trip.facilityName), q) : 0;
    // The patient's name weighs more than the facility's (a facility matches dozens of trips).
    const score = Math.max(byPatient * 2, byFacility);
    if (score === 0) continue;
    const vehicle = trip.vehicleId ? (labelOf.get(trip.vehicleId) ?? "Véhicule") : "Non affectée";
    const cancelled = trip.status === "CANCELLED" ? " · annulée" : trip.status === "NO_SHOW" ? " · patient absent" : "";
    tripHits.push({
      score,
      minute: tripMinute(trip),
      result: {
        kind: "trip",
        id: trip.id,
        title: trip.patientName,
        detail: `${tripWhen(trip)} · ${vehicle}${trip.facilityName ? ` · ${trip.facilityName}` : ""}${cancelled}`,
        vehicleId: trip.vehicleId,
      },
    });
  }

  const vehicleHits: Array<{ score: number; result: SearchResult }> = [];
  for (const vehicle of vehicles) {
    const byLabel = Math.max(matchScore(normalizeText(vehicle.label), q), matchScore(normalizeText(vehicle.registration), q));
    const crew = [vehicle.driverName, vehicle.crewMateName].filter((n): n is string => n !== null);
    const byCrew = Math.max(0, ...crew.map((name) => matchScore(normalizeText(name), q)));
    const byDepot = matchScore(normalizeText(vehicle.depot.label), q);
    const score = Math.max(byLabel * 2, byCrew * 2, byDepot);
    if (score === 0) continue;
    const trips = vehicle.route ? `${vehicle.route.tripCount} course${vehicle.route.tripCount > 1 ? "s" : ""}` : vehicle.available ? "libre" : "indisponible";
    vehicleHits.push({
      score,
      result: {
        kind: "vehicle",
        id: vehicle.id,
        title: vehicle.label,
        detail: [crew.join(" + ") || "Sans chauffeur", `dépôt ${vehicle.depot.label}`, trips].join(" · "),
        vehicleId: vehicle.id,
      },
    });
  }

  tripHits.sort((a, b) => b.score - a.score || a.minute - b.minute);
  vehicleHits.sort((a, b) => b.score - a.score);
  // Interleaved by score: a driver's name beats a facility's, a patient's name beats a depot's.
  const merged = [
    ...tripHits.map((h) => ({ score: h.score, result: h.result, order: 0 })),
    ...vehicleHits.map((h) => ({ score: h.score, result: h.result, order: 1 })),
  ];
  // Stable sort: within a score, trips (in time order) before vehicles.
  merged.sort((a, b) => b.score - a.score || a.order - b.order);
  return merged.slice(0, limit).map((m) => m.result);
}

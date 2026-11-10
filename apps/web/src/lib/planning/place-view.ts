/**
 * « Où placer cette course ? » on the trip panel (INS-01): the places the optimizer found for one
 * trip (POST /insert, lib/planning/insertion.ts), as the panel shows them. Pure and client-safe:
 * grouped by depot, best margin first, the vehicles without a place greyed with their reason, and
 * the French texts of each place (figures against the plan in place, patients delayed).
 */
import type { VehicleType } from "@prisma/client";
import type { RejectionKind } from "@/lib/optimizer/contract";
import { formatDuration, formatMinute } from "@/lib/time";
import type { VehicleRowView } from "./types";

/** One vehicle that can take the trip, and what it changes. */
export type PlaceOptionView = {
  vehicleId: string;
  pickupMinute: number;
  dropoffMinute: number;
  shared: boolean;
  coPassengerTripIds: string[];
  /** Against the plan in place: the target route and, for a move, the source route. */
  deltaKm: number;
  deltaEmptyKm: number;
  deltaDurationMin: number;
  deltaRevenue: number;
  deltaMargin: number;
  /** Other patients of these routes whose times move: the trip and its largest shift (minutes, + later). */
  shifts: { tripId: string; minutes: number }[];
  /** Rules these routes already broke and still break (never a new one). */
  remainingViolations: number;
};

/** The optimizer's kinds, and the web's own: a route under way, a vehicle off the road, a time already past. */
export type PlaceRejectionKind = RejectionKind | "STARTED" | "UNAVAILABLE" | "PAST";

/** Why the assistant has nothing to place a trip in: the day has no route yet (mirrored on the server). */
export const PLACE_NO_ROUTES = "Optimisez d'abord la journée\u00a0: l'assistant place une course dans les tournées en place.";

/**
 * Why the assistant does not move a trip in an exceptional ambulance (TAR-03): the measure holds while it is
 * locked there, and taken off it the trip would be priced and checked as a seated one (mirrored on the server).
 */
export const PLACE_EXCEPTIONAL_AMBULANCE =
  "Recours exceptionnel à une ambulance\u00a0: «\u202fDéfiger\u202f» la course (la mesure tombe) pour lui chercher une place en taxi ou en VSL.";

export type PlaceRejectionView = {
  vehicleId: string;
  kind: PlaceRejectionKind;
  /** To follow the vehicle's name: « est en pause de 12:00 à 12:45 ». */
  reason: string;
};

/** The answer of « Où placer cette course ? » (findPlaces). */
export type PlacesView = {
  tripId: string;
  /** Vehicle of the trip's route, null for a trip without a vehicle. */
  fromVehicleId: string | null;
  /** Version of the plan the places were computed on: « Appliquer » is refused once it changed. */
  version: string;
  /** Best margin first. */
  options: PlaceOptionView[];
  rejected: PlaceRejectionView[];
  /** From the click to the answer, on the server (ms). */
  elapsedMs: number;
  /** Distances estimated at straight line (no road matrix). */
  straightLine: boolean;
};

export type PlaceOptionRow = PlaceOptionView & { label: string; type: VehicleType };
export type PlaceRejectionRow = PlaceRejectionView & { label: string };

export type PlaceGroup = {
  depotId: string;
  depotLabel: string;
  options: PlaceOptionRow[];
  rejected: PlaceRejectionRow[];
};

/**
 * How the panel says a vehicle off the road: « est indisponible ce jour : entretien », the reason's
 * first word in lower case after the colon (« Aucun chauffeur… », but never « VSL »).
 */
export function unavailableReason(vehicle: Pick<VehicleRowView, "unavailableReason">): string {
  const reason = vehicle.unavailableReason ?? "véhicule hors service";
  const lowered = /^\p{Lu}\p{Ll}/u.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason;
  return `est indisponible ce jour\u00a0: ${lowered}`;
}

/**
 * The places by depot: depots with places first, the one of the best place first; then those
 * without, by name. Inside a depot, places by margin (as the optimizer ranked them), then the
 * vehicles without a place, by name. Vehicles of an allowed type off the road that day (never sent
 * to the optimizer) are greyed too; the trip's own vehicle is never listed.
 */
export function groupPlaces(
  view: Pick<PlacesView, "options" | "rejected" | "fromVehicleId">,
  vehicles: readonly VehicleRowView[],
  allowedTypes: readonly VehicleType[],
): PlaceGroup[] {
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  const groups = new Map<string, PlaceGroup>();
  const groupOf = (vehicle: VehicleRowView): PlaceGroup => {
    let group = groups.get(vehicle.depot.id);
    if (!group) {
      group = { depotId: vehicle.depot.id, depotLabel: vehicle.depot.label, options: [], rejected: [] };
      groups.set(vehicle.depot.id, group);
    }
    return group;
  };
  const listed = new Set<string>();
  for (const option of view.options) {
    const vehicle = byId.get(option.vehicleId);
    if (!vehicle || listed.has(vehicle.id)) continue;
    listed.add(vehicle.id);
    groupOf(vehicle).options.push({ ...option, label: vehicle.label, type: vehicle.type });
  }
  for (const rejection of view.rejected) {
    const vehicle = byId.get(rejection.vehicleId);
    if (!vehicle || listed.has(vehicle.id)) continue;
    listed.add(vehicle.id);
    groupOf(vehicle).rejected.push({ ...rejection, label: vehicle.label });
  }
  for (const vehicle of vehicles) {
    if (vehicle.available || listed.has(vehicle.id) || vehicle.id === view.fromVehicleId || !allowedTypes.includes(vehicle.type)) continue;
    listed.add(vehicle.id);
    groupOf(vehicle).rejected.push({ vehicleId: vehicle.id, kind: "UNAVAILABLE", reason: unavailableReason(vehicle), label: vehicle.label });
  }
  const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "fr", { numeric: true });
  for (const group of groups.values()) group.rejected.sort(byName);
  const best = (group: PlaceGroup) => group.options[0]?.deltaMargin ?? Number.NEGATIVE_INFINITY;
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.options.length > 0) - Number(a.options.length > 0) ||
      best(b) - best(a) ||
      a.depotLabel.localeCompare(b.depotLabel, "fr") ||
      a.depotId.localeCompare(b.depotId),
  );
}

const eurosFormat = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
  signDisplay: "exceptZero",
});
const decimalFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: "exceptZero" });
const integerFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0, signDisplay: "exceptZero" });

/** The typographic minus (U+2212) instead of Intl's hyphen-minus, as signedDurationText and the driver app write it. */
function withMinus(format: Intl.NumberFormat): (value: number) => string {
  return (value) => format.format(value).replace(/^-/, "\u2212");
}
const signedEuros = withMinus(eurosFormat);
const signedDecimal = withMinus(decimalFormat);
const signedInteger = withMinus(integerFormat);

/** « marge +18 € », « marge −12 € », « marge inchangée ». */
export function marginText(deltaMargin: number): string {
  return Math.round(deltaMargin) === 0 ? "marge inchangée" : `marge\u00a0${signedEuros(deltaMargin)}`;
}

/** « +6,2 km », « −3,0 km », « 0 km ». */
export function signedKmText(deltaKm: number): string {
  return Math.abs(deltaKm) < 0.05 ? "0\u00a0km" : `${signedDecimal(deltaKm)}\u00a0km`;
}

/** « +25 min », « −1 h 05 », « 0 min ». */
export function signedDurationText(minutes: number): string {
  if (minutes === 0) return "0\u00a0min";
  return `${minutes > 0 ? "+" : "\u2212"}${formatDuration(Math.abs(minutes))}`;
}

/** « prise en charge 09:12 · dépose 09:40 ». */
export function placeTimesText(option: Pick<PlaceOptionView, "pickupMinute" | "dropoffMinute">): string {
  return `prise en charge ${formatMinute(option.pickupMinute)} · dépose ${formatMinute(option.dropoffMinute)}`;
}

/**
 * « +6,2 km dont +2,1 km à vide · +25 min de service · CA +30 € » (what the two routes change). The
 * revenue says why a longer drive can earn more: a patient no longer shared loses the sharing discount.
 */
export function placeFiguresText(option: Pick<PlaceOptionView, "deltaKm" | "deltaEmptyKm" | "deltaDurationMin" | "deltaRevenue">): string {
  const empty = Math.abs(option.deltaEmptyKm) >= 0.05 ? ` dont ${signedKmText(option.deltaEmptyKm)} à vide` : "";
  const revenue = Math.round(option.deltaRevenue) === 0 ? "CA inchangé" : `CA\u00a0${signedEuros(option.deltaRevenue)}`;
  return `${signedKmText(option.deltaKm)}${empty} · ${signedDurationText(option.deltaDurationMin)} de service · ${revenue}`;
}

/**
 * The patients the place delays or advances: « Décale Paul Durand de +8 min », « Décale 3 patients
 * (jusqu'à +12 min) »; null when none moves. A verb, never a participle to agree with the patient.
 */
export function shiftsText(shifts: readonly { tripId: string; minutes: number }[], nameOf: (tripId: string) => string | null): string | null {
  if (shifts.length === 0) return null;
  const largest = shifts.reduce((a, b) => (Math.abs(b.minutes) > Math.abs(a.minutes) ? b : a));
  const amount = `${signedInteger(largest.minutes)}\u00a0min`;
  if (shifts.length === 1) return `Décale ${nameOf(largest.tripId) ?? "un patient"} de ${amount}`;
  return `Décale ${shifts.length} patients (jusqu'à ${amount})`;
}

/** « Partagée avec Jeanne Martin », « Partagée avec Jeanne Martin et Paul Durand »; null when alone. */
export function sharedText(coPassengerTripIds: readonly string[], nameOf: (tripId: string) => string | null): string | null {
  if (coPassengerTripIds.length === 0) return null;
  const names = coPassengerTripIds.map((id) => nameOf(id) ?? "un patient");
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
  return `Partagée avec ${listed}`;
}

/**
 * The headline of the answer: « 12 places possibles sur 40 véhicules compatibles », counted on the
 * groups shown (the vehicles off the road greyed in their depot included).
 */
export function placesSummary(groups: readonly Pick<PlaceGroup, "options" | "rejected">[]): string {
  const options = groups.reduce((sum, group) => sum + group.options.length, 0);
  const total = options + groups.reduce((sum, group) => sum + group.rejected.length, 0);
  const vehicles = `${total} véhicule${total > 1 ? "s" : ""} compatible${total > 1 ? "s" : ""}`;
  if (options === 0) return total === 0 ? "Aucun autre véhicule compatible ce jour" : `Aucune place sur ${vehicles}`;
  const places = options > 1 ? `${options} places possibles` : "1 place possible";
  return `${places} sur ${vehicles}`;
}

/**
 * For a trip already on a vehicle whose best move does not earn more (margin rounded to 0 € or
 * less): « Sa place actuelle reste la plus rentable : chaque déplacement coûte au moins 13 € ».
 * Null otherwise (a gain, or a trip without a vehicle: placing it is the gain). The panel then
 * marks no place as the best one.
 */
export function currentPlaceNote(view: Pick<PlacesView, "fromVehicleId">, best: Pick<PlaceOptionView, "deltaMargin"> | null): string | null {
  if (!view.fromVehicleId || !best || Math.round(best.deltaMargin) > 0) return null;
  const loss = Math.round(-best.deltaMargin);
  return loss === 0
    ? "Sa place actuelle reste la plus rentable\u00a0: aucun déplacement ne rapporte plus."
    : `Sa place actuelle reste la plus rentable\u00a0: chaque déplacement coûte au moins ${loss}\u00a0€.`;
}

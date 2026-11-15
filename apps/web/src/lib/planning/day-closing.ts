/**
 * Closing a day (FLD-02): the trips whose outcome the crews never recorded (no « Déposé », no « Patient absent »), and
 * the entry rate of the day and of each person, the same rate as the dashboard's « Saisie des statuts » (lot 21:
 * trips whose crew recorded the outcome ÷ trips placed on a route, served or absent). The planning of today lists the
 * day before's, the planning of a past day its own; the regulator corrects them from the trip's panel.
 *
 * Who closes the day, and when, is still to agree with V (journal, questions for the PO): nothing is closed here.
 * Pure: the loader passes the day's routes and trips.
 */
import type { TripDirection, TripStatus } from "@prisma/client";

export type ClosingRoute = {
  id: string;
  vehicleLabel: string;
  people: { id: string; name: string }[];
};

export type ClosingTrip = {
  id: string;
  status: TripStatus;
  routeId: string | null;
  direction: TripDirection;
  patientName: string;
  plannedPickupMinute: number | null;
};

export type UnclosedTrip = {
  tripId: string;
  vehicleLabel: string;
  patientName: string;
  direction: TripDirection;
  plannedPickupMinute: number | null;
  /** On board (« Pris en charge » recorded, no « Déposé »), or nothing recorded at all. */
  onBoard: boolean;
};

export type DayClosing = {
  date: string;
  /** Trips placed on a route (served or absent), and those whose outcome was recorded. */
  placed: number;
  recorded: number;
  /** Each person who drove or crewed a route, the lowest rate first. */
  people: { id: string; name: string; placed: number; recorded: number }[];
  unclosed: UnclosedTrip[];
};

const RECORDED: readonly TripStatus[] = ["DROPPED_OFF", "NO_SHOW"];

export function dayClosing(date: string, routes: readonly ClosingRoute[], trips: readonly ClosingTrip[]): DayClosing {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const people = new Map<string, { id: string; name: string; placed: number; recorded: number }>();
  const unclosed: UnclosedTrip[] = [];
  let placed = 0;
  let recorded = 0;
  for (const trip of trips) {
    const route = trip.routeId ? routeById.get(trip.routeId) : undefined;
    if (!route || trip.status === "CANCELLED") continue;
    const done = RECORDED.includes(trip.status);
    placed += 1;
    if (done) recorded += 1;
    for (const person of route.people) {
      const line = people.get(person.id) ?? { ...person, placed: 0, recorded: 0 };
      line.placed += 1;
      if (done) line.recorded += 1;
      people.set(person.id, line);
    }
    if (!done) {
      unclosed.push({
        tripId: trip.id,
        vehicleLabel: route.vehicleLabel,
        patientName: trip.patientName,
        direction: trip.direction,
        plannedPickupMinute: trip.plannedPickupMinute,
        onBoard: trip.status === "PICKED_UP",
      });
    }
  }
  const rate = (line: { placed: number; recorded: number }) => (line.placed > 0 ? line.recorded / line.placed : 1);
  return {
    date,
    placed,
    recorded,
    people: [...people.values()].sort((a, b) => rate(a) - rate(b) || a.name.localeCompare(b.name, "fr")),
    unclosed: unclosed.sort(
      (a, b) => a.vehicleLabel.localeCompare(b.vehicleLabel, "fr", { numeric: true }) || (a.plannedPickupMinute ?? 0) - (b.plannedPickupMinute ?? 0),
    ),
  };
}

/** « 94 % » of a rate (recorded ÷ placed), « — » when nothing was placed. */
export function entryRateText(line: { placed: number; recorded: number }): string {
  if (line.placed === 0) return "—";
  return `${Math.floor((line.recorded / line.placed) * 100)} %`;
}

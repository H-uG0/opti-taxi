import "server-only";
import { db } from "@/lib/db";
import { formatPersonName } from "@/lib/names";
import { addDays, fromIsoDate, toIsoDate } from "@/lib/time";
import { dayClosing, type DayClosing } from "./day-closing";

/** The closing of isoDate (day-closing.ts): its routes' crews and its trips, names only (the page traces plan.view). */
export async function loadDayClosing(isoDate: string): Promise<DayClosing> {
  const serviceDate = fromIsoDate(isoDate);
  const person = { select: { id: true, firstName: true, lastName: true } } as const;
  const [routes, trips] = await Promise.all([
    db.route.findMany({
      where: { serviceDate, stops: { some: {} } },
      select: { id: true, vehicle: { select: { label: true } }, driver: person, crewMate: person },
    }),
    db.trip.findMany({
      where: { serviceDate, routeId: { not: null } },
      select: {
        id: true,
        status: true,
        routeId: true,
        direction: true,
        plannedPickupMinute: true,
        patient: { select: { firstName: true, lastName: true } },
        // The stop holding the outcome: set by the regulation (CORRECTED), it is not the crew's entry.
        stops: { select: { kind: true, routeId: true, completedSource: true } },
      },
    }),
  ]);
  return dayClosing(
    isoDate,
    routes.map((route) => ({
      id: route.id,
      vehicleLabel: route.vehicle.label,
      people: [route.driver, route.crewMate].flatMap((p) => (p ? [{ id: p.id, name: formatPersonName(p, "short") }] : [])),
    })),
    trips.map(({ stops, ...trip }) => {
      const outcomeKind = trip.status === "NO_SHOW" ? "PICKUP" : "DROPOFF";
      const outcome = stops.find((stop) => stop.routeId === trip.routeId && stop.kind === outcomeKind);
      return { ...trip, patientName: formatPersonName(trip.patient), outcomeCorrected: outcome?.completedSource === "CORRECTED" };
    }),
  );
}

/** Days back the planning of today looks for the last day with routes (a long weekend, a public holiday). */
const CLOSING_LOOKBACK_DAYS = 7;

/**
 * The last service day before `today` with routes (on a Monday, usually Saturday: its dialysis sessions), within the
 * last CLOSING_LOOKBACK_DAYS; null when none. The planning of today lists its unclosed trips.
 */
export async function lastServiceDayBefore(today: string): Promise<string | null> {
  const route = await db.route.findFirst({
    where: { serviceDate: { lt: fromIsoDate(today), gte: fromIsoDate(addDays(today, -CLOSING_LOOKBACK_DAYS)) }, stops: { some: {} } },
    orderBy: { serviceDate: "desc" },
    select: { serviceDate: true },
  });
  return route ? toIsoDate(route.serviceDate) : null;
}

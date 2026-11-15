import "server-only";
import { db } from "@/lib/db";
import { formatPersonName } from "@/lib/names";
import { fromIsoDate } from "@/lib/time";
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
      select: { id: true, status: true, routeId: true, direction: true, plannedPickupMinute: true, patient: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  return dayClosing(
    isoDate,
    routes.map((route) => ({
      id: route.id,
      vehicleLabel: route.vehicle.label,
      people: [route.driver, route.crewMate].flatMap((p) => (p ? [{ id: p.id, name: formatPersonName(p, "short") }] : [])),
    })),
    trips.map((trip) => ({ ...trip, patientName: formatPersonName(trip.patient) })),
  );
}

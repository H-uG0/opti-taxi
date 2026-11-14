import "server-only";
import type { Prisma } from "@prisma/client";
import { closedFacilityTrips, holidayOn, type ClosedFacilityGroup, type Holiday } from "@/lib/domain/facility-calendar";
import { fromIsoDate, toIsoDate } from "@/lib/time";

export type ClosedFacilities = { holiday: Holiday | null; groups: ClosedFacilityGroup[] };

/**
 * Read only: the public holiday of `isoDate` (PublicHoliday, else the legal
 * days computed for its year) and the open trips of that day to a facility
 * closed then — not working public holidays, or under a dated closure —, by
 * facility (lib/domain/facility-calendar.ts). `client`: the app's database or
 * a transaction (the cancellation reads them again in its own).
 */
export async function loadClosedFacilityTrips(client: Prisma.TransactionClient, isoDate: string): Promise<ClosedFacilities> {
  const year = isoDate.slice(0, 4);
  const day = fromIsoDate(isoDate);
  const rows = await client.publicHoliday.findMany({
    where: { date: { gte: fromIsoDate(`${year}-01-01`), lte: fromIsoDate(`${year}-12-31`) } },
    select: { date: true, label: true },
  });
  const holiday = holidayOn(
    rows.map((r) => ({ date: toIsoDate(r.date), label: r.label })),
    isoDate,
  );
  const covering = { startDate: { lte: day }, endDate: { gte: day } };
  const trips = await client.trip.findMany({
    where: {
      serviceDate: day,
      status: { in: ["PLANNED", "ASSIGNED"] },
      facility: holiday ? { OR: [{ openOnHolidays: false }, { closures: { some: covering } }] } : { closures: { some: covering } },
    },
    select: {
      id: true,
      facility: { select: { id: true, name: true, openOnHolidays: true, closures: { where: covering, select: { startDate: true, endDate: true } } } },
    },
  });
  return { holiday, groups: closedFacilityTrips(trips, isoDate, holiday) };
}
